import type { Role } from '@shiye/shared';

export type SessionUser = {
  role: Role;
  userId?: string;
  customerId?: string;
  username: string;
  credentialVersion?: string;
};

declare module 'express-serve-static-core' {
  interface Request {
    user?: SessionUser;
  }
}
