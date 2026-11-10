import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { protect, admin } from '../middleware/auth.js';
import { PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { getUploadToSpaces, getS3Client } from '../config/spaces.js';

const router = express.Router();

const cdnUrl = process.env.SPACES_CDN_URL ? process.env.SPACES_CDN_URL.replace(/\/$/, '') : null;
const bucket = process.env.SPACES_BUCKET;
const endpoint = process.env.SPACES_ENDPOINT?.replace(/^https?:\/\//, '');
const uploadsDir = path.join(process.cwd(), 'uploads', 'bag-tags');

const buildPublicUrl = (key) => {
  if (!key) return null;
  if (cdnUrl) return `${cdnUrl}/${key}`;
  if (bucket && endpoint) return `https://${bucket}.${endpoint}/${key}`;
  return null;
};

const ensureUploadsDir = () => {
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }
};

const localLogoUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      ensureUploadsDir();
      cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.png').toLowerCase();
      cb(null, `logo${ext}`);
    }
  }),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    return cb(new Error('Only image files are allowed!'), false);
  }
});

// Error handler for multer
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        message: 'File is too large. Maximum size is 10MB.'
      });
    }
    return res.status(400).json({
      success: false,
      message: err.message
    });
  }
  next(err);
};

// Memory storage for direct SDK uploads (avoids multer-s3 compatibility issues)
const memoryUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    return cb(new Error('Only image files are allowed!'), false);
  }
});

// Upload delivery photo
router.post('/delivery-photo', protect, (req, res, next) => {
  memoryUpload.single('image')(req, res, (err) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ success: false, message: 'File is too large. Maximum size is 10MB.' });
    }
    if (err) return res.status(400).json({ success: false, message: err.message });
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const s3 = getS3Client();
    if (!s3 || !process.env.SPACES_BUCKET) {
      return res.status(503).json({ success: false, message: 'DigitalOcean Spaces is not configured.' });
    }

    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(req.file.originalname || '').toLowerCase() || '.jpg';
    const key = `photos/delivery-${uniqueSuffix}${ext}`;

    const uploadParams = {
      Bucket: process.env.SPACES_BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype || 'image/jpeg',
    };

    // Try upload with public ACL first; fall back without ACL if bucket disallows it
    try {
      await s3.send(new PutObjectCommand({ ...uploadParams, ACL: 'public-read' }));
    } catch (aclErr) {
      const code = aclErr?.Code || aclErr?.code || aclErr?.$metadata?.httpStatusCode;
      const isAclError = ['AccessControlListNotSupported', 'AccessDenied', 'InvalidArgument'].includes(String(code))
        || String(aclErr.message).toLowerCase().includes('acl');
      if (isAclError) {
        console.warn('⚠️  ACL upload failed, retrying without ACL (bucket may have ACLs disabled):', aclErr.message);
        await s3.send(new PutObjectCommand(uploadParams));
      } else {
        throw aclErr;
      }
    }

    const cdnBase = process.env.SPACES_CDN_URL?.replace(/\/$/, '');
    const endpoint = process.env.SPACES_ENDPOINT?.replace(/^https?:\/\//, '');
    const photoUrl = cdnBase
      ? `${cdnBase}/${key}`
      : `https://${process.env.SPACES_BUCKET}.${endpoint}/${key}`;

    console.log(`✅ Photo uploaded: ${key}, size: ${(req.file.size / 1024).toFixed(2)} KB`);

    res.json({
      success: true,
      message: 'Photo uploaded successfully',
      url: photoUrl,
      filename: key,
      size: req.file.size
    });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ success: false, message: 'Upload failed. Please try again.', error: error.message });
  }
});

// Upload bag tag logo (shared)
router.post('/bag-tag-logo', protect, admin, (req, res, next) => {
  const USE_SPACES = Boolean(process.env.SPACES_KEY && process.env.SPACES_SECRET && process.env.SPACES_BUCKET);

  const upload = USE_SPACES
    ? getUploadToSpaces({
        maxFileSize: 2 * 1024 * 1024, // 2MB limit for logo
        keyBuilder: (req, file, cb) => {
          const ext = (path.extname(file.originalname) || '.png').toLowerCase();
          cb(null, `bag-tags/logo${ext}`);
        }
      })
    : localLogoUpload;

  upload.single('image')(req, res, async (err) => {
    if (err) {
      return handleMulterError(err, req, res, next);
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    const isSpaces = Boolean(req.file.key);
    const key = req.file.key || req.file.filename;
    const logoUrl = isSpaces ? (buildPublicUrl(key) || req.file.location) : `${req.protocol}://${req.get('host')}/uploads/bag-tags/${req.file.filename}`;

    res.json({
      success: true,
      message: 'Logo uploaded successfully',
      url: logoUrl,
      filename: key,
      size: req.file.size
    });
  } catch (error) {
    console.error('Logo upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Upload failed. Please try again.',
      error: error.message
    });
  }
});

// Get current bag tag logo URL (public - no auth needed)
router.get('/bag-tag-logo', async (req, res) => {
  try {
    // Prefer CDN/Spaces if configured and the object actually exists
    const s3 = getS3Client();
    const bucketName = process.env.SPACES_BUCKET;
    const candidateKeys = [
      'bag-tags/logo.png',
      'bag-tags/logo.jpg',
      'bag-tags/logo.jpeg',
      'bag-tags/logo.webp',
      'bag-tags/logo.svg'
    ];

    if (s3 && bucketName) {
      for (const key of candidateKeys) {
        try {
          await s3.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
          const url = buildPublicUrl(key);
          if (url) return res.json({ success: true, url });
        } catch (err) {
          // Ignore 404s and continue checking the next candidate
          if (err?.$metadata?.httpStatusCode && err.$metadata.httpStatusCode !== 404) {
            console.warn('Spaces logo headObject error for', key, err.message);
          }
        }
      }
    }

    // Fallback to local file
    ensureUploadsDir();
    const candidates = ['logo.png', 'logo.jpg', 'logo.jpeg', 'logo.webp', 'logo.svg'];
    const files = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
    const found = candidates.find((name) => files.includes(name)) || files.find((name) => name.toLowerCase().startsWith('logo.'));
    if (!found) {
      return res.status(404).json({ success: false, message: 'Logo not configured' });
    }
    const localUrl = `${req.protocol}://${req.get('host')}/uploads/bag-tags/${found}`;
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json({ success: true, url: localUrl });
  } catch (error) {
    console.error('Get logo error:', error);
    return res.status(500).json({ success: false, message: 'Unable to fetch logo', error: error.message });
  }
});

export default router;