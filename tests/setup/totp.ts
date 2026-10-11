import { generateSync } from "otplib";
export const authenticator = (secret: string) => generateSync({ secret });
