import mongoose from 'mongoose';

export const taskOperations = ['uppercase', 'lowercase', 'reverse', 'word_count'];
export const taskStatuses = ['pending', 'running', 'success', 'failed'];

const taskSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  title: {
    type: String,
    required: true,
    trim: true,
    minlength: 1,
    maxlength: 120,
  },
  input: {
    type: String,
    required: true,
    maxlength: 50000,
  },
  operation: {
    type: String,
    required: true,
    enum: taskOperations,
  },
  status: {
    type: String,
    required: true,
    enum: taskStatuses,
    default: 'pending',
  },
  result: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  processingLogs: [{
    message: { type: String, required: true, maxlength: 500 },
    timestamp: { type: Date, required: true, default: Date.now },
  }],
}, {
  timestamps: true,
  toJSON: {
    transform(_document, result) {
      delete result.userId;
      delete result.__v;
      return result;
    },
  },
});

taskSchema.index({ userId: 1, createdAt: -1 });
taskSchema.index({ status: 1, createdAt: 1 });

export default mongoose.model('Task', taskSchema);