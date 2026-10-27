module.exports = {
  apps: [{
    name: 'matter-delivery-api',
    script: './server.js',
    instances: 2,
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'development',
      PORT: 5000,
      MONGODB_URI: 'your-mongodb-uri',
      JWT_SECRET: 'your-jwt-secret',
      JWT_EXPIRES_IN: '7d',
      CLIENT_URL: 'https://your-client-url',
      UPLOAD_PATH: './uploads',
      MAX_FILE_SIZE: '5242880',
      LOCAL_TIMEZONE_OFFSET_MINUTES: '240',
      SPACES_KEY: 'your-spaces-key',
      SPACES_SECRET: 'your-spaces-secret',
      SPACES_BUCKET: 'your-spaces-bucket',
      SPACES_ENDPOINT: 'your-spaces-endpoint',
      SPACES_REGION: 'your-spaces-region',
      SPACES_CDN_URL: 'your-spaces-cdn-url'
    },
    env_production: {
      NODE_ENV: 'production',
      // Raise only after this Android versionCode is available to all drivers.
      // 0 disables required updates. Restart PM2 with --update-env after edits.
      MOBILE_ANDROID_MIN_BUILD: '0',
      MOBILE_UPDATE_MESSAGE: 'Update Delivery Driver to continue.',
      PORT: 5000,
      MONGODB_URI: 'your-mongodb-uri',
      JWT_SECRET: 'your-jwt-secret',
      JWT_EXPIRES_IN: '7d',
      CLIENT_URL: 'https://your-client-url',
      UPLOAD_PATH: './uploads',
      MAX_FILE_SIZE: '5242880',
      LOCAL_TIMEZONE_OFFSET_MINUTES: '240',
      SPACES_KEY: 'your-spaces-key',
      SPACES_SECRET: 'your-spaces-secret',
      SPACES_BUCKET: 'your-spaces-bucket',
      SPACES_ENDPOINT: 'your-spaces-endpoint',
      SPACES_REGION: 'your-spaces-region',
      SPACES_CDN_URL: 'your-spaces-cdn-url'
    }
  }]
};
