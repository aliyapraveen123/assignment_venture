import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    unique: true,
    maxlength: 254,
  },
  passwordHash: {
    type: String,
    required: true,
    select: false,
  },
}, {
  timestamps: true,
  toJSON: {
    transform(_document, result) {
      delete result.passwordHash;
      delete result.__v;
      return result;
    },
  },
});

export default mongoose.model('User', userSchema);