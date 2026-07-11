import mongoose from 'mongoose';

const OtpSessionSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    required: true
  },
  otp: {
    type: String,
    required: true
  },
  createdAt: {
    type: Date,
    default: Date.now,
    expires: 300 // 5 minutes in seconds
  }
});

const OtpSession = mongoose.model('OtpSession', OtpSessionSchema);

export default OtpSession;
