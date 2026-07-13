import twilio from 'twilio';

let client = null;

// Helper to retrieve Twilio configuration dynamically from environment variables
const getTwilioConfig = () => {
  return {
    accountSid: process.env.TWILIO_ACCOUNT_SID || process.env.Account_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN || process.env.Auth_token,
    fromNumber: process.env.TWILIO_PHONE_NUMBER || process.env.TWILIO_FROM_NUMBER,
  };
};

/**
 * Initializes the Twilio client if credentials are available.
 * Returns the client instance, or null if credentials are missing.
 */
const getClient = () => {
  if (client) return client;

  const { accountSid, authToken } = getTwilioConfig();
  if (!accountSid || !authToken) {
    return null;
  }

  try {
    client = twilio(accountSid, authToken);
    return client;
  } catch (error) {
    console.error('[Twilio Service Error] Failed to initialize Twilio client:', error.message);
    return null;
  }
};

/**
 * Verifies Twilio configuration and prints warnings if credentials are missing.
 * This can be called at application startup (after env variables are loaded).
 */
export const verifyTwilioConfig = () => {
  const { accountSid, authToken } = getTwilioConfig();
  if (!accountSid || !authToken) {
    console.warn('[Twilio Service Warning] Twilio Account SID or Auth Token is missing. OTP SMS delivery will be unavailable.');
  }
};

/**
 * Sends a 6-digit OTP code to the specified phone number using Twilio SMS.
 * 
 * @param {string} to - The recipient's phone number in E.164 format.
 * @param {string} otp - The 6-digit OTP code.
 * @returns {Promise<object>} The Twilio API message response.
 */
export const sendOtp = async (to, otp) => {
  const formattedTo = to.trim();

  // Bypass sending SMS for the mock phone number used in testing
  if (formattedTo === '+19998887777') {
    console.log(`[Twilio Service] Mock phone number ${formattedTo} detected. Skipping Twilio SMS send. OTP: ${otp}`);
    return { sid: 'mock_sms_sid', status: 'queued', mock: true };
  }

  const { accountSid, authToken, fromNumber } = getTwilioConfig();

  if (!accountSid || !authToken) {
    throw new Error('Twilio credentials (TWILIO_ACCOUNT_SID / Account_SID and TWILIO_AUTH_TOKEN / Auth_token) are not set in the environment variables.');
  }

  if (!fromNumber) {
    throw new Error('Twilio from phone number (TWILIO_PHONE_NUMBER / TWILIO_FROM_NUMBER) is not set in the environment variables.');
  }

  const activeClient = getClient();
  if (!activeClient) {
    throw new Error('Failed to initialize Twilio client. Please check your credentials.');
  }

  try {
    console.log(`[Twilio Service] Sending SMS to ${formattedTo}...`);
    const message = await activeClient.messages.create({
      body: `Your Cricket RAG Verification Code is: ${otp}. It is valid for 5 minutes. Please do not share this code with anyone.`,
      from: fromNumber,
      to: formattedTo
    });
    console.log(`[Twilio Service] SMS sent successfully. Message SID: ${message.sid}`);
    return message;
  } catch (error) {
    console.error(`[Twilio Service] Failed to send SMS to ${formattedTo}:`, error);
    throw error;
  }
};

export default { sendOtp, verifyTwilioConfig };

