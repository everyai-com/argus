const unavailable = async () => {
  throw new Error("Cloudflare Browser Rendering is unavailable in deterministic unit tests");
};

export const launch = unavailable;
export const connect = unavailable;
