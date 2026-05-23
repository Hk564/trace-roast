import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';

export function verifyTraceSignature(secret: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const signature = req.headers['x-trace-signature'] as string;
    const timestamp = req.headers['x-trace-timestamp'] as string;

    if (!signature || !timestamp) {
      return res.status(401).json({ error: 'Missing signature or timestamp' });
    }

    // Verify timestamp (prevent replay attacks, e.g., 5 min tolerance)
    const now = Date.now();
    const requestTime = parseInt(timestamp, 10);
    if (isNaN(requestTime) || Math.abs(now - requestTime) > 5 * 60 * 1000) {
      return res.status(401).json({ error: 'Request timestamp expired or invalid' });
    }

    // Hash: hmac_sha256(secret, timestamp + "." + rawBody)
    // IMPORTANT: use the raw request bytes, NOT JSON.stringify(req.body).
    // Re-serialising can change field order and break the signature check.
    // rawBody is captured in index.ts via express.json({ verify: ... }).
    const rawBody  = (req as any).rawBody?.toString() ?? JSON.stringify(req.body);
    const expected = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');

    try {
      if (crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
        return next();
      }
    } catch (e) {
      // Buffer length mismatch or other error
    }

    console.error('[HMAC] Signature mismatch');
    return res.status(401).json({ error: 'Invalid signature' });
  };
}
