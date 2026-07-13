/**
 * 2Factor SMS Gateway Integration Service
 * 
 * Handles sending OTPs using the 2Factor.in REST API.
 */

/**
 * Sends a 6-digit OTP code to the specified phone number using 2Factor API.
 * 
 * @param {string} to - The recipient's phone number in E.164 format.
 * @param {string} otp - The 6-digit OTP code.
 * @returns {Promise<object>} The 2Factor API response details.
 */
export const sendOtp = async (to, otp) => {
  const formattedTo = to.trim();

  // Bypass sending SMS for the mock phone number used in testing
  if (formattedTo === '+19998887777') {
    console.log(`[2Factor Service] Mock phone number ${formattedTo} detected. Skipping 2Factor SMS send. OTP: ${otp}`);
    return { Status: 'Success', Details: 'mock_session_id', mock: true };
  }

  const apiKey = process.env.TWOFACTOR_API_KEY;
  const templateName = process.env.TWOFACTOR_TEMPLATE_NAME;

  // Handle configuration errors by falling back in development
  if (!apiKey) {
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[2Factor Service Warning] 2Factor API key (TWOFACTOR_API_KEY) is missing. Falling back to mock SMS flow. OTP: ${otp}`);
      return { Status: 'Success', Details: 'mock_session_id_fallback', mock: true };
    }
    throw new Error('2Factor API Key (TWOFACTOR_API_KEY) is not set in the environment variables.');
  }

  try {
    console.log(`[2Factor Service] Sending SMS to ${formattedTo}...`);
    // Format the URL. If a template is configured, append it.
    let url = `https://2factor.in/API/V1/${apiKey}/SMS/${formattedTo}/${otp}`;
    if (templateName) {
      url += `/${templateName.trim()}`;
    }

    const response = await fetch(url, { method: 'GET' });
    const data = await response.json();

    if (data.Status !== 'Success') {
      throw new Error(data.Details || 'Failed to send SMS via 2Factor');
    }

    console.log(`[2Factor Service] SMS sent successfully. Session ID: ${data.Details}`);
    return data;
  } catch (error) {
    console.error(`[2Factor Service] Failed to send SMS to ${formattedTo}:`, error.message);

    // Fallback to mock SMS flow in development mode so testing/login is not blocked
    if (process.env.NODE_ENV !== 'production') {
      console.warn(`[2Factor Service Warning] Falling back to mock SMS flow in development mode. OTP: ${otp}`);
      return { Status: 'Success', Details: 'mock_session_id_fallback', mock: true };
    }

    throw error;
  }
};

/**
 * Verifies 2Factor configuration and prints warnings if the API key is missing.
 * This can be called at application startup (after env variables are loaded).
 */
export const verifyTwoFactorConfig = () => {
  const apiKey = process.env.TWOFACTOR_API_KEY;
  if (!apiKey) {
    console.warn('[2Factor Service Warning] 2Factor API key (TWOFACTOR_API_KEY) is missing. OTP SMS delivery will be unavailable.');
  }
};

export default { sendOtp, verifyTwoFactorConfig };
