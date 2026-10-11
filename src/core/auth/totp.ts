import { generateSecret, generateURI, verifySync } from "otplib";

export function newTotpSecret() {
  return generateSecret();
}

export function totpUri(secret: string, account: string) {
  return generateURI({ issuer: "ASL ORIGINALS", label: account, secret });
}

export function verifyTotp(secret: string, token: string) {
  try {
    return verifySync({ secret, token, epochTolerance: 30 }).valid;
  } catch {
    return false;
  }
}
