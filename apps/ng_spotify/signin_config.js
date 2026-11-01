'use strict';
/**
 * Sign-in with the phone (QR), see docs/spotify.md "Sign-in with the phone".
 *
 * relay:   the https address of the sign-in relay page (index.html, relay.js, relay.css: static files, no
 *          secrets; the published copy is this repository's gh-pages branch), exactly as it is listed
 *          as a Redirect URI of your Spotify app, e.g. 'https://<your relay host>/'.
 *          Empty: the QR sign-in is off and the app says so on its sign-in screen.
 * mailbox: the ntfy server the relay page hands the sign-in to; the car polls it over its internet
 *          uplink. The published relay accepts only https://ntfy.sh (relay.js MAILBOXES and its CSP
 *          connect-src): another server here needs your own relay copy that lists it. Everything on it is end-to-end encrypted (AES-256-GCM,
 *          the key travels only inside the QR code and Spotify's "state").
 *
 * No client ID here: the phone asks for it once (and the car keeps it in spotify-auth.json).
 */
module.exports = {
    relay: 'https://nickgcode.github.io/idrive7-apps/',
    mailbox: 'https://ntfy.sh',
};
