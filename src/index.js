function generatePin() {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function generateUserId(seed = "BPM") {
  const clean = String(seed || "BPM").replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 5) || "BPM";
  const num = Math.floor(100 + Math.random() * 900);
  return `${clean}${num}`;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };
}

export default {
  async fetch(request, env) {
    const headers = corsHeaders();

    if (request.method === "OPTIONS") {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    if (request.method !== "POST") {
      return new Response(JSON.stringify({ success: false, message: "Only POST allowed." }), {
        status: 405,
        headers
      });
    }

    try {
      const apiKey = env.FAST2SMS_API_KEY;
      const dbUrl = String(env.FIREBASE_DB_URL || "").replace(/\/+$/, "");

      if (!apiKey) {
        return new Response(
          JSON.stringify({ success: false, message: "FAST2SMS_API_KEY secret set nahi hai." }),
          { status: 500, headers }
        );
      }

      if (!dbUrl) {
        return new Response(
          JSON.stringify({ success: false, message: "FIREBASE_DB_URL variable set nahi hai." }),
          { status: 500, headers }
        );
      }

      const body = await request.json();
      const action = String(body.action || "").trim();
      const mobile = String(body.mobile || "").replace(/\D/g, "").slice(-10);
      const userIdInput = String(body.userId || "").trim().toUpperCase();

      if (!/^[6-9]\d{9}$/.test(mobile)) {
        return new Response(
          JSON.stringify({ success: false, message: "Sahi 10-digit mobile number daalein." }),
          { status: 400, headers }
        );
      }

      const usersRes = await fetch(`${dbUrl}/users.json`);
      if (!usersRes.ok) {
        return new Response(
          JSON.stringify({ success: false, message: "Firebase se user data nahi padha ja saka." }),
          { status: 502, headers }
        );
      }
      const usersObj = (await usersRes.json()) || {};

      const matchedEntry = Object.entries(usersObj).find(([, u]) => {
        if (!u) return false;
        const uMob = String(u.mobile || "").replace(/\D/g, "").slice(-10);
        const uIdMatch = !userIdInput || String(u.userId || "").toUpperCase() === userIdInput;
        return uMob === mobile && uIdMatch;
      });

      if (!matchedEntry) {
        return new Response(
          JSON.stringify({ success: false, message: "Yeh mobile number / User ID registered nahi hai." }),
          { status: 404, headers }
        );
      }

      const [userKey, userData] = matchedEntry;

      if (action === "send_otp") {
        const otp = String(Math.floor(100000 + Math.random() * 900000));
        const expiresAt = Date.now() + 5 * 60 * 1000;

        await fetch(`${dbUrl}/otpRequests/${mobile}.json`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            otp,
            expiresAt,
            attempts: 0,
            userKey
          })
        });

        const params = new URLSearchParams({
          authorization: apiKey,
          route: "otp",
          variables_values: otp,
          flash: "0",
          numbers: mobile
        });

        const smsRes = await fetch(`https://www.fast2sms.com/dev/bulkV2?${params.toString()}`);
        const smsData = await smsRes.json();

        if (!smsData.return) {
          return new Response(
            JSON.stringify({
              success: false,
              message: smsData.message || "Fast2SMS se OTP bhejne mein samasya aayi."
            }),
            { status: 502, headers }
          );
        }

        return new Response(
          JSON.stringify({
            success: true,
            message: "OTP aapke registered mobile number par bhej diya gaya hai."
          }),
          { status: 200, headers }
        );
      }

      if (action === "verify_and_reset") {
        const otpEntered = String(body.otp || "").trim();
        const otpRes = await fetch(`${dbUrl}/otpRequests/${mobile}.json`);
        const savedOtp = await otpRes.json();

        if (!savedOtp || !savedOtp.otp) {
          return new Response(
            JSON.stringify({ success: false, message: "Pehle OTP mangayein ya OTP expire ho gaya hai." }),
            { status: 400, headers }
          );
        }

        if (Date.now() > Number(savedOtp.expiresAt || 0)) {
          await fetch(`${dbUrl}/otpRequests/${mobile}.json`, { method: "DELETE" });
          return new Response(
            JSON.stringify({ success: false, message: "OTP expire ho gaya hai. Dobara OTP bhejein." }),
            { status: 400, headers }
          );
        }

        const currentAttempts = Number(savedOtp.attempts || 0);
        if (currentAttempts >= 5) {
          await fetch(`${dbUrl}/otpRequests/${mobile}.json`, { method: "DELETE" });
          return new Response(
            JSON.stringify({ success: false, message: "Bahut zyada galat koshishein hui hain. Naya OTP bhejein." }),
            { status: 429, headers }
          );
        }

        if (String(savedOtp.otp) !== otpEntered) {
          await fetch(`${dbUrl}/otpRequests/${mobile}.json`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ attempts: currentAttempts + 1 })
          });
          return new Response(
            JSON.stringify({ success: false, message: "Galat OTP. Kripya sahi 6-digit OTP daalein." }),
            { status: 400, headers }
          );
        }

        const newUserId = generateUserId(userIdInput || userData.userId || "BPM");
        const newPin = generatePin();

        await fetch(`${dbUrl}/users/${userKey}.json`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userId: newUserId,
            pin: newPin,
            updatedAt: Date.now()
          })
        });

        await fetch(`${dbUrl}/otpRequests/${mobile}.json`, { method: "DELETE" });

        return new Response(
          JSON.stringify({
            success: true,
            message: "OTP verify ho gaya! Naya User ID aur PIN taiyar hai.",
            newUserId,
            newPin
          }),
          { status: 200, headers }
        );
      }

      return new Response(JSON.stringify({ success: false, message: "Invalid action." }), {
        status: 400,
        headers
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ success: false, message: "Worker error: " + err.message }),
        { status: 500, headers }
      );
    }
  }
};
