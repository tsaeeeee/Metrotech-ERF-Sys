import passport from 'passport';
import { Strategy as GoogleStrategy } from 'passport-google-oauth20';

let serializersConfigured=false;

export function googleAuthReady(settings){
  return Boolean(
    settings?.googleEnabled &&
    settings?.googleClientId &&
    settings?.googleClientSecret &&
    settings?.googleCallbackUrl
  );
}

export function configureAuth(settings) {
  if(!googleAuthReady(settings)) return false;

  passport.use('google',new GoogleStrategy(
    {
      clientID:settings.googleClientId,
      clientSecret:settings.googleClientSecret,
      callbackURL:settings.googleCallbackUrl
    },
    (accessToken,refreshToken,profile,done)=>{
      try{
        const email=String(profile.emails?.[0]?.value||'').toLowerCase();
        if(!email) return done(null,false,{message:'Google account email was not returned.'});

        const domain=String(settings.allowedGoogleDomain||'').toLowerCase().trim();
        if(domain && !email.endsWith('@'+domain))
          return done(null,false,{message:'Company Google Workspace account required.'});

        return done(null,{email,googleId:profile.id,displayName:profile.displayName||email});
      }catch(err){
        return done(err);
      }
    }
  ));

  if(!serializersConfigured){
    passport.serializeUser((user,done)=>done(null,{email:user.email}));
    passport.deserializeUser((user,done)=>done(null,user));
    serializersConfigured=true;
  }
  return true;
}

export { passport };
