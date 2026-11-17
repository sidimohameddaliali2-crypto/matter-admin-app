import mongoose from 'mongoose';
import { installActivityDatabase } from './activityDatabase.js';
import { recordActivity } from './activityStore.js';

// Evaluate before route modules compile their Mongoose models.
installActivityDatabase(mongoose, recordActivity);
