import { useState } from "react";

function App() {
  const [url, setUrl] = useState("");
  const [shortUrl, setShortUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();

    if (!url.trim()) {
      setError("Please enter a URL.");
      return;
    }

    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      setError("Please enter a valid URL starting with http:// or https://");
      return;
    }

    setLoading(true);
    setError("");
    setShortUrl("");
    setCopied(false);

    try {
      const response = await fetch("https://linkshortner-zsel.onrender.com/shorten", {
    method: "POST",
    headers: {
        "Content-Type": "application/json",
    },
    body: JSON.stringify({
        url: url.trim(),
    }),
});

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.detail || "Unable to shorten URL.");
      }

      if (data.short_url) {
        setShortUrl(data.short_url);
      } else {
        setError("Something went wrong. No short URL received.");
      }
    } catch (err) {
      console.error(err);
      setError(
        "Could not connect to the server. Make sure your FastAPI backend is running."
      );
    } finally {
      setLoading(false);
    }
  };

  const copyLink = async () => {
    if (!shortUrl) return;

    try {
      await navigator.clipboard.writeText(shortUrl);
      setCopied(true);

      setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (err) {
      console.error(err);
      setError("Could not copy the link.");
    }
  };

  const clearAll = () => {
    setUrl("");
    setShortUrl("");
    setError("");
    setCopied(false);
  };

  return (
    <>
      <div className="app">
        {/* Background effects */}
        <div className="glow glowOne"></div>
        <div className="glow glowTwo"></div>

        {/* Navbar */}
        <nav className="navbar">
          <div className="brand">
            <div className="brandIcon">↗</div>
            <span>LinkShortner</span>
          </div>

          <div className="navLinks">
            <a href="#features">Features</a>
            <a href="#about">About</a>
          </div>
        </nav>

        {/* Main */}
        <main className="main">
          <div className="badge">
            <span>✦</span>
            Free • Fast • Simple • No Login
          </div>

          <h1>
            Short links.
            <br />
            <span>Big possibilities.</span>
          </h1>

          <p className="subtitle">
            Transform long URLs into short, clean and shareable links
            instantly.
            <br className="desktopBreak" />
            No account required.
          </p>

          {/* URL Form */}
          <form className="shortenerForm" onSubmit={handleSubmit}>
            <input
              type="url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError("");
              }}
              placeholder="Paste your long URL here..."
              aria-label="Long URL"
            />

            <button type="submit" disabled={loading}>
              {loading ? "Shortening..." : "Shorten ↗"}
            </button>
          </form>

          <div className="hint">Press Enter to shorten your link</div>

          {/* Error */}
          {error && <div className="errorBox">⚠ {error}</div>}

          {/* Result */}
          {shortUrl && (
            <div className="resultBox">
              <div className="resultHeader">
                <div>
                  <div className="resultLabel">YOUR SHORT LINK</div>
                  <div className="successText">✓ Link created successfully</div>
                </div>

                <button className="clearButton" onClick={clearAll}>
                  ×
                </button>
              </div>

              <div className="shortLinkRow">
                {/* Clicking this directly opens the backend redirect */}
                <a
                  href={shortUrl}
                  className="shortLink"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {shortUrl}
                </a>

                <button className="copyButton" onClick={copyLink}>
                  {copied ? "✓ Copied" : "Copy"}
                </button>

                <a
                  href={shortUrl}
                  className="openButton"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Open ↗
                </a>
              </div>

              <p className="redirectInfo">
                Clicking the short link will redirect to your original URL.
              </p>
            </div>
          )}

          {/* Features */}
          <section className="features" id="features">
            <div className="feature">
              <div className="featureIcon">⚡</div>
              <div>
                <h3>Instant</h3>
                <p>Create short links in seconds</p>
              </div>
            </div>

            <div className="feature">
              <div className="featureIcon">🔒</div>
              <div>
                <h3>Simple</h3>
                <p>No account or registration required</p>
              </div>
            </div>

            <div className="feature">
              <div className="featureIcon">↗</div>
              <div>
                <h3>Redirect</h3>
                <p>Short links open the original URL</p>
              </div>
            </div>
          </section>

          {/* About */}
          <section className="about" id="about">
            <h2>LinkShortner</h2>
            <p>
              A free and simple URL shortening service designed to turn long
              web addresses into clean, shareable links.
            </p>
          </section>
        </main>

        {/* Footer */}
        <footer>
          LinkShortner • Free URL Shortening Service
        </footer>
      </div>

      {/* All styling is included here */}
      <style>{`
        * {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }

        html {
          scroll-behavior: smooth;
        }

        body {
          margin: 0;
          font-family: Inter, Arial, Helvetica, sans-serif;
          background: #050816;
          color: white;
        }

        button,
        input {
          font-family: inherit;
        }

        .app {
          min-height: 100vh;
          width: 100%;
          overflow-x: hidden;
          position: relative;
          background:
            radial-gradient(
              circle at 50% 25%,
              rgba(0, 140, 255, 0.24),
              transparent 35%
            ),
            radial-gradient(
              circle at 20% 80%,
              rgba(95, 45, 255, 0.13),
              transparent 30%
            ),
            linear-gradient(135deg, #050816 0%, #08142c 50%, #030611 100%);
        }

        .glow {
          position: absolute;
          border-radius: 50%;
          filter: blur(90px);
          pointer-events: none;
          opacity: 0.35;
        }

        .glowOne {
          width: 280px;
          height: 280px;
          background: #0077ff;
          top: 120px;
          left: 50%;
          transform: translateX(-50%);
        }

        .glowTwo {
          width: 220px;
          height: 220px;
          background: #7040ff;
          bottom: 100px;
          right: -80px;
        }

        .navbar {
          width: 100%;
          height: 70px;
          padding: 0 6%;
          display: flex;
          align-items: center;
          justify-content: space-between;
          position: relative;
          z-index: 5;
          border-bottom: 1px solid rgba(255, 255, 255, 0.08);
          background: rgba(4, 9, 24, 0.65);
          backdrop-filter: blur(12px);
        }

        .brand {
          display: flex;
          align-items: center;
          gap: 10px;
          font-weight: 800;
          font-size: 18px;
        }

        .brandIcon {
          width: 34px;
          height: 34px;
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, #4da3ff, #5d63ff);
          box-shadow: 0 8px 25px rgba(40, 130, 255, 0.35);
          font-size: 18px;
        }

        .navLinks {
          display: flex;
          gap: 28px;
        }

        .navLinks a {
          color: #c9d4e8;
          text-decoration: none;
          font-size: 14px;
          transition: 0.2s;
        }

        .navLinks a:hover {
          color: white;
        }

        .main {
          width: min(100%, 1050px);
          margin: 0 auto;
          min-height: calc(100vh - 110px);
          padding: 55px 24px 25px;
          display: flex;
          align-items: center;
          flex-direction: column;
          position: relative;
          z-index: 2;
        }

        .badge {
          padding: 8px 15px;
          border: 1px solid rgba(93, 177, 255, 0.35);
          background: rgba(52, 143, 255, 0.1);
          color: #b8ddff;
          border-radius: 999px;
          font-size: 13px;
          margin-bottom: 20px;
          box-shadow: 0 0 25px rgba(0, 132, 255, 0.1);
        }

        .badge span {
          color: #62c7ff;
        }

        h1 {
          text-align: center;
          font-size: clamp(42px, 7vw, 76px);
          line-height: 0.98;
          letter-spacing: -3px;
          font-weight: 900;
          margin-bottom: 20px;
        }

        h1 span {
          background: linear-gradient(90deg, #ffffff, #71caff);
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
          background-clip: text;
        }

        .subtitle {
          color: #b5c3d9;
          text-align: center;
          font-size: 16px;
          line-height: 1.6;
          max-width: 700px;
          margin-bottom: 28px;
        }

        .shortenerForm {
          width: min(100%, 760px);
          display: flex;
          padding: 6px;
          border-radius: 16px;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(105, 187, 255, 0.25);
          box-shadow:
            0 20px 60px rgba(0, 0, 0, 0.35),
            0 0 35px rgba(0, 132, 255, 0.08);
        }

        .shortenerForm input {
          flex: 1;
          min-width: 0;
          border: none;
          outline: none;
          background: transparent;
          color: white;
          padding: 15px 16px;
          font-size: 15px;
        }

        .shortenerForm input::placeholder {
          color: #8493aa;
        }

        .shortenerForm button {
          border: none;
          border-radius: 11px;
          padding: 0 25px;
          min-width: 125px;
          background: linear-gradient(135deg, #23b5ff, #1877ff);
          color: white;
          font-weight: 800;
          cursor: pointer;
          transition: 0.2s;
          box-shadow: 0 8px 25px rgba(23, 130, 255, 0.3);
        }

        .shortenerForm button:hover {
          transform: translateY(-1px);
          filter: brightness(1.08);
        }

        .shortenerForm button:disabled {
          opacity: 0.65;
          cursor: wait;
          transform: none;
        }

        .hint {
          margin-top: 9px;
          color: #667790;
          font-size: 11px;
        }

        .errorBox {
          width: min(100%, 760px);
          margin-top: 16px;
          padding: 13px 16px;
          border-radius: 12px;
          background: rgba(255, 70, 90, 0.1);
          border: 1px solid rgba(255, 90, 110, 0.3);
          color: #ffabb7;
          font-size: 13px;
        }

        .resultBox {
          width: min(100%, 760px);
          margin-top: 18px;
          padding: 20px;
          border-radius: 16px;
          background: rgba(11, 24, 49, 0.85);
          border: 1px solid rgba(75, 170, 255, 0.2);
          box-shadow: 0 20px 50px rgba(0, 0, 0, 0.3);
        }

        .resultHeader {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 14px;
        }

        .resultLabel {
          color: #7890ae;
          font-size: 10px;
          letter-spacing: 1.5px;
          font-weight: 800;
        }

        .successText {
          color: #72e4a0;
          font-size: 13px;
          margin-top: 4px;
        }

        .clearButton {
          border: none;
          background: rgba(255, 255, 255, 0.07);
          color: #aab8ca;
          width: 30px;
          height: 30px;
          border-radius: 8px;
          cursor: pointer;
          font-size: 20px;
        }

        .shortLinkRow {
          display: flex;
          gap: 9px;
          align-items: stretch;
        }

        .shortLink {
          flex: 1;
          min-width: 0;
          display: flex;
          align-items: center;
          padding: 13px 15px;
          border-radius: 10px;
          background: rgba(0, 0, 0, 0.25);
          border: 1px solid rgba(255, 255, 255, 0.08);
          color: #6bc8ff;
          text-decoration: none;
          overflow: hidden;
          white-space: nowrap;
          text-overflow: ellipsis;
          font-size: 14px;
        }

        .shortLink:hover {
          color: white;
          border-color: rgba(80, 180, 255, 0.4);
        }

        .copyButton,
        .openButton {
          border: none;
          border-radius: 10px;
          padding: 0 18px;
          display: flex;
          align-items: center;
          justify-content: center;
          text-decoration: none;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
        }

        .copyButton {
          background: #243a5d;
          color: white;
        }

        .copyButton:hover {
          background: #315075;
        }

        .openButton {
          background: #168bff;
          color: white;
        }

        .openButton:hover {
          background: #3da4ff;
        }

        .redirectInfo {
          margin-top: 12px;
          color: #71839d;
          font-size: 11px;
          text-align: center;
        }

        .features {
          width: min(100%, 760px);
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 12px;
          margin-top: 20px;
        }

        .feature {
          min-width: 0;
          padding: 16px;
          border-radius: 14px;
          background: rgba(11, 24, 49, 0.75);
          border: 1px solid rgba(255, 255, 255, 0.07);
          display: flex;
          align-items: center;
          gap: 12px;
        }

        .featureIcon {
          width: 38px;
          height: 38px;
          flex-shrink: 0;
          border-radius: 10px;
          display: flex;
          align-items: center;
          justify-content: center;
          background: rgba(50, 150, 255, 0.1);
          font-size: 18px;
        }

        .feature h3 {
          font-size: 13px;
          margin-bottom: 4px;
        }

        .feature p {
          color: #73859f;
          font-size: 11px;
          line-height: 1.4;
        }

        .about {
          width: min(100%, 760px);
          margin-top: 20px;
          text-align: center;
          padding: 16px;
        }

        .about h2 {
          font-size: 14px;
          margin-bottom: 5px;
        }

        .about p {
          color: #687b95;
          font-size: 11px;
          line-height: 1.5;
        }

        footer {
          text-align: center;
          padding: 12px 20px 20px;
          color: #55667d;
          font-size: 10px;
          position: relative;
          z-index: 2;
        }

        /* Tablet */
        @media (max-width: 800px) {
          .main {
            padding-top: 42px;
          }

          h1 {
            font-size: clamp(40px, 9vw, 62px);
          }

          .features {
            grid-template-columns: repeat(3, 1fr);
          }

          .feature {
            padding: 13px;
          }
        }

        /* Mobile */
        @media (max-width: 600px) {
          .navbar {
            height: 60px;
            padding: 0 18px;
          }

          .brand {
            font-size: 15px;
          }

          .brandIcon {
            width: 30px;
            height: 30px;
          }

          .navLinks {
            gap: 13px;
          }

          .navLinks a {
            font-size: 11px;
          }

          .main {
            min-height: auto;
            padding: 38px 14px 18px;
          }

          .badge {
            font-size: 10px;
            padding: 7px 11px;
            margin-bottom: 15px;
          }

          h1 {
            font-size: clamp(38px, 12vw, 54px);
            letter-spacing: -2px;
            line-height: 1;
          }

          .subtitle {
            font-size: 12px;
            line-height: 1.5;
            margin-bottom: 20px;
          }

          .desktopBreak {
            display: none;
          }

          .shortenerForm {
            padding: 5px;
            border-radius: 13px;
          }

          .shortenerForm input {
            padding: 13px 10px;
            font-size: 13px;
          }

          .shortenerForm button {
            min-width: 92px;
            padding: 0 10px;
            font-size: 12px;
          }

          .hint {
            font-size: 9px;
          }

          .features {
            grid-template-columns: 1fr;
            gap: 8px;
            margin-top: 16px;
          }

          .feature {
            padding: 11px;
          }

          .featureIcon {
            width: 34px;
            height: 34px;
            font-size: 16px;
          }

          .feature h3 {
            font-size: 12px;
          }

          .feature p {
            font-size: 10px;
          }

          .resultBox {
            padding: 14px;
          }

          .shortLinkRow {
            flex-direction: column;
          }

          .shortLink {
            min-height: 44px;
          }

          .copyButton,
          .openButton {
            min-height: 42px;
            width: 100%;
          }

          .about {
            margin-top: 12px;
          }
        }

        /* Very small phones */
        @media (max-width: 380px) {
          .navLinks a {
            display: none;
          }

          h1 {
            font-size: 36px;
          }

          .shortenerForm button {
            min-width: 82px;
          }
        }
      `}</style>
    </>
  );
}

export default App;