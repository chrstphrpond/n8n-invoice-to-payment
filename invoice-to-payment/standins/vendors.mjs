// Stand-ins for the four outside services the invoicing workflows call. Each follows a public API shape closely
// enough for the workflow to be pointed at the real thing by changing a base URL and a key, and each records
// what it received so the tests can assert on it.
//
//   pdf      POST /pdf/v1/render              { html, filename, options }  -> application/pdf bytes
//   storage  PUT  /storage/objects/:bucket/:key*   (bytes)                 -> { key, size, sha256, etag }
//            GET  /storage/objects/:bucket/:key*                          -> the bytes
//   email    POST /email/emails               Resend's send-email body     -> { id }    (honors Idempotency-Key, like Resend)
//   payments POST /payments/v1/refunds        { payment_reference, amount, currency, metadata } -> refund (honors Idempotency-Key)
import { createHash } from 'node:crypto';
import { bearer } from '../../_shared/lib/standin.mjs';

const sha256 = data => createHash('sha256').update(data).digest('hex');

// A small, valid one-page PDF with the document's text, made deterministically from the HTML: the same HTML gives
// the same bytes. A real renderer lays the HTML out; this one only proves the bytes flow and are checked.
export function minimalPdf(lines) {
  const escape = text => text.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, ch => `\\${ch}`);
  const content = ['BT', '/F1 10 Tf', '13 TL', '56 790 Td', ...lines.slice(0, 55).map(line => `(${escape(line.slice(0, 95))}) '`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

export function htmlText(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<\/(tr|p|h1|h2|div|dd|header|footer|section)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&middot;/g, '-').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .split('\n').map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
}

export function pdfRenderer({ token, prefix = '/pdf' }) {
  return {
    name: 'pdf',
    init: () => ({ renders: [] }),
    view: s => ({ renders: s.renders }),
    routes: [{
      method: 'POST', path: `${prefix}/v1/render`, op: 'pdf.render', auth: bearer(token),
      handle: (req, s) => {
        const html = req.body?.html;
        if (typeof html !== 'string' || !/<html/i.test(html)) return { status: 400, body: { error: 'html must be an HTML document' } };
        if (html.length > 2_000_000) return { status: 413, body: { error: 'document too large' } };
        const bytes = minimalPdf(htmlText(html));
        s.renders.push({ filename: req.body.filename ?? null, html_sha256: sha256(html), pdf_sha256: sha256(bytes), size: bytes.length, html });
        return { status: 200, raw: bytes, contentType: 'application/pdf', headers: { 'content-disposition': `attachment; filename="${req.body.filename ?? 'document.pdf'}"` } };
      },
    }],
  };
}

export function objectStorage({ token, prefix = '/storage' }) {
  return {
    name: 'storage',
    init: () => ({ objects: new Map(), puts: 0 }),
    view: s => ({ objects: [...s.objects.values()].map(({ bytes: _bytes, ...meta }) => meta), puts: s.puts }),
    routes: [
      {
        method: 'PUT', path: `${prefix}/objects/:bucket/:key*`, op: 'storage.put_object', idempotency: 'ignore', auth: bearer(token),
        handle: (req, s) => {
          if (!req.raw.length) return { status: 400, body: { error: 'empty body' } };
          if (!/^application\/pdf/.test(req.headers['content-type'] ?? '')) return { status: 415, body: { error: `content-type must be application/pdf, got ${req.headers['content-type']}` } };
          const path = `${req.params.bucket}/${req.params.key}`;
          const digest = sha256(req.raw);
          s.puts += 1;
          const overwrote = s.objects.has(path);
          s.objects.set(path, { path, size: req.raw.length, sha256: digest, content_type: 'application/pdf', bytes: Buffer.from(req.raw), writes: (s.objects.get(path)?.writes ?? 0) + 1 });
          return { status: 200, body: { key: req.params.key, bucket: req.params.bucket, size: req.raw.length, sha256: digest, etag: `"${digest.slice(0, 32)}"` }, log: { outcome: overwrote ? 'overwrote_same_key' : 'created' } };
        },
      },
      {
        method: 'GET', path: `${prefix}/objects/:bucket/:key*`, op: 'storage.get_object', auth: bearer(token),
        handle: (req, s) => {
          const object = s.objects.get(`${req.params.bucket}/${req.params.key}`);
          if (!object) return { status: 404, body: { error: 'NoSuchKey' } };
          return { status: 200, raw: object.bytes, contentType: 'application/pdf' };
        },
      },
    ],
  };
}

// Resend's POST /emails: { from, to, subject, html, text, attachments: [{ filename, content (base64) }], tags }.
// Resend keeps an Idempotency-Key for 24 hours and answers a repeat with the first answer; so does this stand-in.
export function emailApi({ key, prefix = '/email' }) {
  const fail = (status, name, message) => ({ status, body: { statusCode: status, name, message } });
  return {
    name: 'email',
    init: () => ({ sent: [], nextId: 1 }),
    view: s => ({ sent: s.sent }),
    routes: [{
      method: 'POST', path: `${prefix}/emails`, op: 'email.send', idempotency: 'honor', auth: bearer(key),
      handle: (req, s) => {
        const body = req.body ?? {};
        const to = Array.isArray(body.to) ? body.to : [body.to].filter(Boolean);
        if (typeof body.from !== 'string' || !body.from.includes('@')) return fail(422, 'validation_error', 'Invalid `from` field.');
        if (!to.length || to.some(address => typeof address !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(address))) return fail(422, 'validation_error', 'Invalid `to` field.');
        if (typeof body.subject !== 'string' || !body.subject) return fail(422, 'missing_required_field', 'Missing `subject` field.');
        if (!body.html && !body.text) return fail(422, 'missing_required_field', 'Missing `html` or `text` field.');
        const attachments = (body.attachments ?? []).map(file => {
          const bytes = Buffer.from(file.content ?? '', 'base64');
          return { filename: file.filename, size: bytes.length, sha256: sha256(bytes), is_pdf: bytes.slice(0, 5).toString('latin1') === '%PDF-' };
        });
        const id = `test-email-${String(s.nextId++).padStart(4, '0')}`;
        s.sent.push({ id, from: body.from, to, subject: body.subject, text: body.text ?? null, html: body.html ?? null, tags: body.tags ?? [], attachments, idempotency_key: req.headers['idempotency-key'] });
        return { status: 200, body: { id } };
      },
    }],
  };
}

export function paymentsApi({ key, prefix = '/payments' }) {
  return {
    name: 'payments',
    init: () => ({ refunds: [], nextId: 1 }),
    view: s => ({ refunds: s.refunds }),
    routes: [{
      method: 'POST', path: `${prefix}/v1/refunds`, op: 'payments.create_refund', idempotency: 'honor', auth: bearer(key),
      handle: (req, s) => {
        const { payment_reference: reference, amount, currency, metadata = {} } = req.body ?? {};
        if (typeof reference !== 'string' || !Number.isSafeInteger(amount) || amount <= 0 || !/^[A-Z]{3}$/.test(currency ?? '')) {
          return { status: 400, body: { error: { type: 'invalid_request_error', message: 'payment_reference, a positive integer amount and currency are required' } } };
        }
        const refund = { id: `re_test_${String(s.nextId++).padStart(4, '0')}`, object: 'refund', status: 'pending', payment_reference: reference, amount, currency, metadata };
        s.refunds.push(refund);
        return { status: 200, body: refund };
      },
    }],
  };
}
