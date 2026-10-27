const buildNumber = value => /^\d+$/.test(String(value || '')) && Number.isSafeInteger(Number(value))
  ? Number(value) : 0;

// Only raise the minimum after that build is available on the drivers' Play
// track. No database or authentication is required to read this public policy.
export function mobileUpdatePolicy(env = process.env) {
  return {
    android: {
      minimumBuild: buildNumber(env.MOBILE_ANDROID_MIN_BUILD),
      message: String(env.MOBILE_UPDATE_MESSAGE || 'Update Delivery Driver to continue.').slice(0, 500),
    },
  };
}
