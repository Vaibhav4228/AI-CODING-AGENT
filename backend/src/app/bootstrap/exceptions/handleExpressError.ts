import { NextFunction, Response, Request } from "express";

export function handleExpressError(err: Error, req: Request, res: Response, next: NextFunction) {
  // Set a default status code if it's not already set
  const statusCode = res.statusCode !== 200 ? res.statusCode : 500;

  res.status(statusCode).json({
    error: {
      message: err.message,
      status: statusCode,
    },
  });
}
