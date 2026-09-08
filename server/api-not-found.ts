import type { RequestHandler } from "express";
// Install after registered APIs and before either Vite or the SPA fallback.
export const apiNotFound: RequestHandler = (req,res,next) => {
  if (/^\/(?:api|vrs)(?:\/|$)/.test(req.path)) {
    res.status(404).json({error:"NOT_FOUND",message:"No API endpoint matches this method and path."});
    return;
  }
  next();
};
