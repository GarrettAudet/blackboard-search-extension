// Pure Blackboard session classification helpers shared by the service worker and release tests.
(function exposeBlackboardSessionHelpers() {
  const LOGIN_PATH_PATTERN = /(?:^|\/)(?:login|logon|signin|sign-in|auth|authentication|sso|cas|saml|oauth)(?:\/|$)/i;

  function assessBlackboardSession(input = {}) {
    const requestedUrl = safeUrl(input.requested_url || input.requestedUrl || "");
    const finalUrl = safeUrl(input.final_url || input.finalUrl || input.requested_url || input.requestedUrl || "");
    const status = Number(input.status || 0);
    const contentType = String(input.content_type || input.contentType || "");
    const body = String(input.body || "").slice(0, 250000);

    if (!requestedUrl || !finalUrl) return sessionResult(false, "invalid_url", finalUrl);
    if (status < 200 || status >= 400) return sessionResult(false, "http_error", finalUrl);
    if (finalUrl.origin !== requestedUrl.origin) return sessionResult(false, "redirected_to_login", finalUrl);
    if (LOGIN_PATH_PATTERN.test(finalUrl.pathname)) return sessionResult(false, "login_url", finalUrl);
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
      return sessionResult(false, "unexpected_content_type", finalUrl);
    }
    if (looksLikeLoginPage(body)) return sessionResult(false, "login_page", finalUrl);
    return sessionResult(true, "authenticated", finalUrl);
  }

  function looksLikeLoginPage(body) {
    const html = String(body || "");
    if (!html) return false;
    if (/<input\b[^>]*\btype\s*=\s*["']?password\b/i.test(html)) return true;
    if (/<form\b[^>]*(?:id|class|action)\s*=\s*["'][^"']*(?:login|logon|signin|sign-in|auth)/i.test(html)) return true;

    const text = html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 30000);
    const hasLoginAction = /\b(?:log\s*in|login|sign\s*in|single\s+sign[- ]?on)\b/i.test(text);
    const hasCredentialPrompt = /\b(?:password|username|user\s+name|identity\s+provider|forgot\s+password)\b/i.test(text);
    return hasLoginAction && hasCredentialPrompt;
  }

  function sessionResult(authenticated, reason, finalUrl) {
    return {
      authenticated,
      reason,
      final_url: finalUrl ? finalUrl.href : ""
    };
  }

  function safeUrl(value) {
    try {
      const parsed = new URL(String(value || ""));
      return /^https?:$/.test(parsed.protocol) ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  globalThis.BlackboardSession = Object.freeze({
    assessBlackboardSession,
    looksLikeLoginPage
  });
})();
