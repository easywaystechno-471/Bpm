function generatePin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function generateUserId(seed = "BPM") {
  const clean = String(seed || "BPM")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .slice(0, 5) || "BPM";
  const num = Math.floor(100 + Math.random() * 900);
  return `${clean}${num}`;
}

function normalizeMobile(raw) {
  return String(raw || "").replace(/\D/g, "").slice(-10);
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders()
  });
}

async function findUserRecord(dbUrl, mobile, userIdInput) {
  const candidateRoots = ["users", "bms"];

  for (const root of candidateRoots) {
    const res = await fetch(`${dbUrl}/${root}.json`);
    if (!res.ok) {
      return { error: `Firebase se ${root} data nahi padha ja saka.` };
    }

    const data = await res.json();
    if (!data || typeof data !== "object") {
      continue;
    }

    const entries = Object.entries(data);
    const matched = entries.find(([, u]) => {
      if (!u || typeof u !== "object") return false;
      const uMob = normalizeMobile(u.mobile || u.phone || u.contact);
      const uCode = String(u.userId || u.id || u.code || "").trim().toUpperCase();
      const idMatches = !userIdInput || uCode === userIdInput;
      return uMob === mobile && idMatches;
    });

    if (matched) {
      return {
        root,
        userKey: matched[0],
        userData: matched[1]
      };
    }
  }

  return {
    notFound: "Yeh mobile number / User ID registered nahi hai."
  };
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return jsonResponse({ ok: true }, 200);
    }

    if (request.method !== "POST") {
      return jsonResponse({ success: false, message: "Only POST allowed." }, 405);
    }

    try {
      const apiKey = String(env.FAST2SMS_API_KEY || "").trim();
      const dbUrl = String(env.FIREBASE_DB_URL || "")
        .trim()
        .replace(/\/+$/, "");

      if (!apiKey) {
        return jsonResponse(
          { success: false, message: "FAST2SMS_API_KEY secret set nahi hai." },
          500
        );
      }

      if (!dbUrl) {
        return jsonResponse(
          { success: false, message: "FIREBASE_DB_URL variable set nahi hai." },
          500
        );
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse(
          { success: false, message: "Invalid JSON request body." },
          400
        );
      }

      const action = String(body.action || "").trim();
      const mobile = normalizeMobile(body.mobile);
      const userIdInput = String(body.userId || "").trim().toUpperCase();
      const isNewSetup = userIdInput === "SETUP" || userIdInput === "NEW" || userIdInput === "REGISTER";

      if (!/^[6-9]\d{9}$/.test(mobile)) {
        return jsonResponse(
          { success: false, message: "Sahi 10-digit mobile number daalein." },
          400
        );
      }

      let lookup = { root: "users", userKey: mobile, userData: {} };
      if (!isNewSetup) {
        lookup = await findUserRecord(dbUrl, mobile, userIdInput);
        if (lookup.error) {
          return jsonResponse({ success: false, message: lookup.error }, 502);
        }
        if (lookup.notFound) {
          return jsonResponse({ success: false, message: lookup.notFound }, 404);
        }
      }

      const { root, userKey, userData } = lookup;

      if (action === "send_otp") {
        const otp = String(Math.floor(100000 + Math.random() * 900000));
        const expiresAt = Date.now() + 5 * 60 * 1000;

        const saveOtpRes = await fetch(`${dbUrl}/otpRequests/${mobile}.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            otp,
            expiresAt,
            attempts: 0,
            isNewSetup,
            root,
            userKey
          })
        });

        if (!saveOtpRes.ok) {
          return jsonResponse(
            { success: false, message: "Firebase mein OTP save nahi ho saka." },
            502
          );
        }

        const params = new URLSearchParams({
          authorization: apiKey,
          route: "otp",
          variables_values: otp,
          flash: "0",
          numbers: mobile
        });

        const smsRes = await fetch(`https://www.fast2sms.com/dev/bulkV2?${params.toString()}`);
        const smsData = await smsRes.json().catch(() => ({}));

        if (!smsRes.ok || !smsData.return) {
          return jsonResponse(
            {
              success: false,
              message: smsData.message || "Fast2SMS se OTP bhejne mein samasya aayi."
            },
            502
          );
        }

        return jsonResponse(
          {
            success: true,
            message: "OTP aapke mobile number par bhej diya gaya hai."
          },
          200
        );
      }

      if (action === "verify_and_reset") {
        const otpEntered = String(body.otp || "").trim();
        if (!/^\d{4,6}$/.test(otpEntered)) {
          return jsonResponse(
            { success: false, message: "Kripya sahi OTP daalein." },
            400
          );
        }

        const otpRes = await fetch(`${dbUrl}/otpRequests/${mobile}.json`);
        if (!otpRes.ok) {
          return jsonResponse(
            { success: false, message: "OTP record padhne mein samasya aayi." },
            502
          );
        }

        const savedOtp = await otpRes.json();
        if (!savedOtp || !savedOtp.otp) {
          return jsonResponse(
            { success: false, message: "Pehle OTP mangayein ya OTP expire ho gaya hai." },
            400
          );
        }

        if (Date.now() > Number(savedOtp.expiresAt || 0)) {
          await fetch(`${dbUrl}/otpRequests/${mobile}.json`, { method: "DELETE" });
          return jsonResponse(
            { success: false, message: "OTP expire ho gaya hai. Dobara OTP bhejein." },
            400
          );
        }

        const currentAttempts = Number(savedOtp.attempts || 0);
        if (currentAttempts >= 5) {
          await fetch(`${dbUrl}/otpRequests/${mobile}.json`, { method: "DELETE" });
          return jsonResponse(
            { success: false, message: "Bahut zyada galat koshishein hui hain. Naya OTP bhejein." },
            429
          );
        }

        if (String(savedOtp.otp).trim() !== otpEntered) {
          await fetch(`${dbUrl}/otpRequests/${mobile}.json`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ attempts: currentAttempts + 1 })
          });
          return jsonResponse(
            { success: false, message: "Galat OTP. Kripya sahi OTP daalein." },
            400
          );
        }

        await fetch(`${dbUrl}/otpRequests/${mobile}.json`, { method: "DELETE" });

        if (savedOtp.isNewSetup || isNewSetup) {
          return jsonResponse(
            {
              success: true,
              message: "OTP verify ho gaya! Ab apna Name, Admin ID aur Password set karein."
            },
            200
          );
        }

        const targetRoot = savedOtp.root || root;
        const targetKey = savedOtp.userKey || userKey;
        const newUserId = generateUserId(userIdInput || (userData && userData.userId) || "BPM");
        const newPin = generatePin();

        const updateRes = await fetch(`${dbUrl}/${targetRoot}/${targetKey}.json`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: newUserId,
            pin: newPin,
            updatedAt: Date.now()
          })
        });

        if (!updateRes.ok) {
          return jsonResponse(
            { success: false, message: "Firebase mein naya User ID / PIN save nahi ho saka." },
            502
          );
        }

        return jsonResponse(
          {
            success: true,
            message: "OTP verify ho gaya! Naya User ID aur PIN taiyar hai.",
            newUserId,
            newPin
          },
          200
        );
      }

      return jsonResponse({ success: false, message: "Invalid action." }, 400);
    } catch (err) {
      return jsonResponse(
        { success: false, message: "Worker error: " + err.message },
        500
      );
    }
  }
};
