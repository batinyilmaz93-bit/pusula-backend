// email.js — sends transactional email via Resend's HTTP API.
//
// Render's free web services block outbound SMTP ports (25/465/587), so a
// traditional nodemailer+SMTP setup wouldn't work there anyway. Resend (and
// similar providers like Postmark/SendGrid) send over plain HTTPS instead,
// which free Render services can use without restriction.
//
// Setup: create a free account at https://resend.com, verify a sending
// domain (or use their shared onboarding domain for testing), and set
// RESEND_API_KEY as an environment variable. Without it, this module logs
// the email to the server console instead of sending it — enough to keep
// developing/testing the reset flow, but real users won't receive anything
// until a key is configured.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || "Pusula <onboarding@resend.dev>";

export async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.log(`[email] RESEND_API_KEY ayarlanmamış — e-posta gönderilmedi. Alıcı: ${to}, Konu: ${subject}`);
    console.log(`[email] İçerik (sadece log, gerçek e-posta değil):\n${html}`);
    return { sent: false, reason: "RESEND_API_KEY not configured" };
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("[email] Resend gönderim hatası:", res.status, detail);
    return { sent: false, reason: `Resend error ${res.status}` };
  }
  return { sent: true };
}
