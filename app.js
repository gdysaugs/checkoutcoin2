const CONTACT_EMAIL = "supportmaxxx777@gmail.com";

function valueOf(formData, key) {
  return String(formData.get(key) || "").trim();
}

function buildMailBody(formData) {
  const rows = [
    ["お名前", valueOf(formData, "name")],
    ["会社名・屋号", valueOf(formData, "company") || "未入力"],
    ["メールアドレス", valueOf(formData, "email")],
    ["電話番号", valueOf(formData, "phone") || "未入力"],
    ["利用用途", valueOf(formData, "usage")],
    ["希望する長さ", valueOf(formData, "duration") || "未入力"],
    ["希望納期", valueOf(formData, "deadline") || "未入力"],
    ["希望する雰囲気・参考曲", valueOf(formData, "mood") || "未入力"],
    ["相談内容", valueOf(formData, "message")],
  ];

  return rows.map(([label, value]) => `${label}: ${value}`).join("\n");
}

function setupContactForm() {
  const form = document.getElementById("contactForm");
  const status = document.getElementById("formStatus");
  if (!form) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    if (!form.reportValidity()) {
      return;
    }

    const formData = new FormData(form);
    const subject = "AudioCreate オリジナルBGM制作相談";
    const body = buildMailBody(formData);
    const mailto = new URL(`mailto:${CONTACT_EMAIL}`);
    mailto.searchParams.set("subject", subject);
    mailto.searchParams.set("body", body);

    window.location.href = mailto.toString();
    if (status) {
      status.textContent = "メールアプリを開きました。内容を確認して送信してください。";
    }
  });
}

setupContactForm();
