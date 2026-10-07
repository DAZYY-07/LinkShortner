/**
 * Google Apps Script that sends LinkShortener verification emails from your Gmail.
 * Deploy it as a web app (see EMAIL_VERIFICATION.md) and point GMAIL_SCRIPT_URL at it.
 * Set the script property SECRET to the same value as GMAIL_SCRIPT_SECRET on the backend.
 */
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const secret = PropertiesService.getScriptProperties().getProperty("SECRET");
    if (!secret || data.secret !== secret) return reply({ ok: false, error: "unauthorized" });
    if (!data.to || !data.subject) return reply({ ok: false, error: "missing recipient or subject" });

    MailApp.sendEmail({
      to: data.to,
      subject: data.subject,
      body: data.text || "",
      htmlBody: data.html || data.text || "",
      name: data.name || "LinkShortener",
    });
    return reply({ ok: true, remainingQuota: MailApp.getRemainingDailyQuota() });
  } catch (error) {
    return reply({ ok: false, error: String(error) });
  }
}

function reply(result) {
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}
