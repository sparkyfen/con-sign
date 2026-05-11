<!--
  Coming Soon Splash. Mirrors Pencil mockups D6dfT (1440w desktop) and
  X6tFwK (390w mobile). One responsive page; the desktop ↔ mobile fork
  hits at 768px (between the mockup widths). Marketing-only — logged-in
  users won't be redirected away yet; this is the unauth entry point.

  Sign In is rendered disabled (matches the mockup's muted `--ink-25`
  color) since /login isn't built yet. Swap the <span> back to an <a
  href="/login"> when the login page lands.
-->
<svelte:head>
  <title>con-sign — your door has lore now</title>
  <link rel="canonical" href="https://cons.social/" />

  <!-- Open Graph + Twitter Card. og.png is 1200x630, mirrors the splash
       typography (Playfair headline + cons.social wordmark). -->
  <meta property="og:type" content="website" />
  <meta property="og:url" content="https://cons.social/" />
  <meta property="og:site_name" content="con-sign" />
  <meta property="og:title" content="con-sign — your door has lore now" />
  <meta
    property="og:description"
    content="Stick an e-ink screen on your hotel door. Update your status from your phone. Never answer 'where are you' again."
  />
  <meta property="og:locale" content="en_US" />
  <meta property="og:image" content="https://cons.social/og.png" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta
    property="og:image:alt"
    content="Editorial typography: 'YOUR DOOR HAS LORE NOW.' over 'cons.social'"
  />

  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="con-sign — your door has lore now" />
  <meta
    name="twitter:description"
    content="Stick an e-ink screen on your hotel door. Update your status from your phone. Never answer 'where are you' again."
  />
  <meta name="twitter:image" content="https://cons.social/og.png" />
</svelte:head>

<div class="page">
  <nav class="nav">
    <span class="wordmark">CON·SIGN</span>
    <span class="signin" aria-disabled="true" title="Sign-in coming soon">SIGN IN</span>
  </nav>

  <section class="hero">
    <p class="eyebrow">THE HOTEL DOOR UPGRADE NOBODY ASKED FOR</p>
    <h1 class="headline">YOUR DOOR HAS<br />LORE NOW.</h1>
  </section>

  <p class="subtitle">
    Stick an e-ink screen on your hotel door. Update your status from your
    phone. Never answer 'where are you' again.
  </p>

  <section class="features">
    <article class="feature">
      <span class="feature-num">01</span>
      <h2 class="feature-title">REAL-TIME STATUS</h2>
      <p class="feature-body">
        In the room? Passed out? Gone feral in the dealers' den? Set it from
        your phone and the door handles the rest.
      </p>
    </article>
    <article class="feature">
      <span class="feature-num">02</span>
      <h2 class="feature-title">E-INK DOOR SIGN</h2>
      <p class="feature-body">
        A little e-ink screen that sits on your door and never dies. Shows
        who's around, what they're doing, and a QR code so people can find
        you.
      </p>
    </article>
    <article class="feature">
      <span class="feature-num">03</span>
      <h2 class="feature-title">PRIVACY TIERS</h2>
      <p class="feature-body">
        Randos get the basics. Friends with the passcode get the full
        picture. You pick who sees what.
      </p>
    </article>
  </section>

  <footer class="footer">
    <span class="footer-mark">cons.social</span>
    <span class="footer-copy">© 2026 CON·SIGN</span>
  </footer>
</div>

<style>
  /* Mobile-first; desktop refinements at 768px+. Mockup widths are
     390 (mobile) and 1440 (desktop); the breakpoint is between. */
  .page {
    display: flex;
    flex-direction: column;
    min-height: 100dvh;
    background: var(--paper);
  }

  /* ─── nav ─────────────────────────────────────────────────────────── */
  .nav {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 20px 24px;
  }
  .wordmark {
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 3px;
    color: var(--ink);
  }
  .signin {
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 2px;
    color: var(--ink-25);
    cursor: not-allowed;
    user-select: none;
  }

  /* ─── hero ────────────────────────────────────────────────────────── */
  .hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    padding: 80px 24px 0;
    text-align: center;
  }
  .eyebrow {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 10px;
    letter-spacing: 3px;
    color: var(--ink-50);
  }
  .headline {
    margin: 0;
    font-family: var(--font-display);
    font-size: 56px;
    font-weight: 700;
    line-height: 0.95;
    letter-spacing: -2px;
    color: var(--ink);
  }

  /* ─── subtitle ────────────────────────────────────────────────────── */
  .subtitle {
    margin: 0 auto;
    padding: 0 24px 48px;
    text-align: center;
    font-family: var(--font-mono);
    font-size: 14px;
    line-height: 1.7;
    color: var(--ink-50);
    max-width: 60ch;
  }

  /* ─── features ────────────────────────────────────────────────────── */
  .features {
    display: flex;
    flex-direction: column;
    gap: 40px;
    padding: 40px 24px 48px;
  }
  .feature {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .feature-num {
    font-family: var(--font-mono);
    font-size: 11px;
    letter-spacing: 2px;
    color: var(--ink-50);
  }
  .feature-title {
    margin: 0;
    font-family: var(--font-display);
    font-size: 20px;
    font-weight: 700;
    letter-spacing: 1px;
    color: var(--ink);
  }
  .feature-body {
    margin: 0;
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.6;
    color: var(--ink-50);
  }

  /* ─── footer ──────────────────────────────────────────────────────── */
  .footer {
    margin-top: auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 32px 24px;
  }
  .footer-mark {
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
  }
  .footer-copy {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--ink-50);
  }

  /* ─── desktop ─────────────────────────────────────────────────────── */
  @media (min-width: 768px) {
    .nav {
      padding: 24px 120px;
    }
    .nav .wordmark {
      font-size: 14px;
    }

    .hero {
      padding: 120px 80px 0;
      gap: 24px;
    }
    .eyebrow {
      font-size: 11px;
    }
    .headline {
      font-size: clamp(72px, 9vw, 130px);
      letter-spacing: -3px;
    }

    .subtitle {
      padding: 0 200px 80px;
      font-size: 15px;
      max-width: none;
    }

    .features {
      flex-direction: row;
      gap: 48px;
      padding: 80px 120px;
    }
    .feature {
      flex: 1 1 0;
      gap: 16px;
    }
    .feature-title {
      font-size: 24px;
    }

    .footer {
      padding: 48px 120px;
    }
    .footer-mark,
    .footer-copy {
      font-size: 13px;
    }
  }
</style>
