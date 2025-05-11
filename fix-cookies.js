const fs = require('fs');
const cookies = JSON.parse(fs.readFileSync('twitch_cookies.json', 'utf8'));
for (const c of cookies) {
  if (!c.sameSite || c.sameSite === null || c.sameSite === 'no_restriction') {
    c.sameSite = 'Lax';
  }
}
fs.writeFileSync('twitch_cookies.json', JSON.stringify(cookies, null, 2));
console.log('Cookies repariert!');