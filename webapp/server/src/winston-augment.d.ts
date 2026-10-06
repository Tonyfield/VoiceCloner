import "winston";

declare module "winston" {
  interface Logger {
    /** loguru-style success level (maps to info with ✅ emoji). */
    success(message: string, ...meta: any[]): Logger;
  }
}