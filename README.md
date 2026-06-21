## Pairing Code with @whiskeysockets/baileys

<p align="center">
  <a href="https://session.empiretech.com.ng">
    <img src="https://i.ibb.co/W5grzHJ/pk.jpg" alt="Example Output" width="80%" />
  </a>
</p>

<p align="center">
  <a href="https://session.empiretech.com.ng">
    HERE'S AN EXAMPLE OUTPUT
  </a>
</p>

<p align="center">
<a href="https://github.com/empiretechlabs/followers"><img title="Followers" src="https://img.shields.io/github/followers/empiretechlabs?color=blue&style=flat-square"></a>
<a href="https://github.com/empiretechlabs/pair-example/stargazers/"><img title="Stars" src="https://img.shields.io/github/stars/empiretechlabs/pair-example?color=blue&style=flat-square"></a>
<a href="https://github.com/empiretechlabs/pair-example/network/members"><img title="Forks" src="https://img.shields.io/github/forks/empiretechlabs/pair-example?color=blue&style=flat-square"></a>
<a href="https://github.com/empiretechlabs/pair-example/"><img title="Size" src="https://img.shields.io/github/repo-size/empiretechlabs/pair-example?style=flat-square&color=green"></a>
<a href="https://github.com/empiretechlabs/pair-example/graphs/commit-activity"><img height="20" src="https://img.shields.io/badge/Maintained%3F-yes-green.svg"></a>&nbsp;&nbsp;
</p>
<p align='center'>
</p>

<p align="center">

  <a aria-label="Join our chats" href="https://t.me/empretech_updates" target="_blank">
    <img alt="telegram" src="https://img.shields.io/badge/Join Group-25D366?style=for-the-badge&logo=telegram&logoColor=white" />
  </a>
 

---

A simple example of a pairing code server that uses `@whiskeysockets/baileys`  and stores session credentials in MEGA with an ID.

## Getting Started

<p align="center">
<a href="https://github.com/empiretechlabs/pair-example/fork">
<img src="https://img.shields.io/badge/Fork%20Repo-Click%20Here-black?style=for-the-badge&logo=github" />
</a>
</p>

1. **Clone the repository**
   ```bash
   git clone https://github.com/empiretechlabs/pair-example.git
   cd pair-example
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure your MEGA and session settings**
   - Edit `config.js` and set add your Mega account password and email and session prefix

   ```javascript
   module.exports = {
       EMAIL: "your-mega-email",
       PASS: "your-mega-password",
       PREFIX: "EMPIRE-MD×" // Customize your session ID prefix here
   };
   ```

4. **Run the script**

   ```bash
   npm start
   ```

   - To stop or restart, you can use:
     ```bash
     npm run stop
     npm run restart
     ```

5. **Pairing Usage**
     ```
     http://localhost:3000/pair?code=+6969696969
     ```
---
