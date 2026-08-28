import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';

export function configureAuth() {
  passport.use(new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL
    },
    (accessToken, refreshToken, profile, done) => {
      try {
        const email = String(profile.emails?.[0]?.value || '').toLowerCase();
        if (!email) return done(null, false, { message: 'Google account email was not returned.' });

        const domain = String(process.env.ALLOWED_GOOGLE_DOMAIN || '').toLowerCase();
        if (domain && !email.endsWith('@' + domain)) {
          return done(null, false, { message: 'Company Google Workspace account required.' });
        }

        return done(null, { email, googleId: profile.id, displayName: profile.displayName || email });
      } catch (err) {
        return done(err);
      }
    }
  ));

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));
}

export function requireAuth(req, res, next) {
  if (req.isAuthenticated?.() && req.user?.email) return next();
  return res.status(401).json({ error: 'Authentication required.' });
}
