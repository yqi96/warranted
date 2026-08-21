---
name: paper-download-browser
description: Download scholarly papers through a real browser when publisher pages, institutional login, redirects, or JavaScript prevent a direct fetch. Use only for open-access content or access the user is authorized to use. Never bypass paywalls, CAPTCHAs, authentication, rate limits, or other access controls.
---

# Browser-assisted Paper Download

Obtain the exact paper the user requested and save a verified local PDF without weakening or evading access controls.

Use this skill when a DOI or publisher page is reachable but direct HTTP download is insufficient because navigation, institutional access, redirects, consent screens, or JavaScript are involved. For ordinary open PDF URLs, download directly without browser automation.

Before operating the browser, load the `browser` skill and follow its session and human-handoff rules.

## Resolve the target

Record enough identity to detect a wrong download:

- DOI, PMID, arXiv id, or canonical landing URL;
- exact or normalized title;
- first author and year when available;
- requested version, such as version of record, accepted manuscript, preprint, or supplementary information.

If the request is ambiguous, resolve the paper identity before downloading. Do not silently substitute a similarly titled paper, a correction, an editorial, or supplementary material for the article.

## Choose the least privileged route

Try routes in this order, stopping at the first legitimate success:

1. A known direct open-access PDF URL.
2. The DOI or publisher landing page's explicit PDF/download control.
3. A legitimate open repository linked from the record, such as a publisher repository, PubMed Central, arXiv, or an institutional repository.
4. The publisher route after the user completes an authorized institutional or personal login in the browser.

Do not treat access failure as a reason to search for unauthorized copies. When no permitted route succeeds, report the access status and preserve the canonical URL so the user can obtain the paper through a librarian, document-delivery service, or another authorized channel.

## Browser procedure

1. Open an isolated browser session and retain its session id.
2. Navigate to the canonical record.
3. Inspect the page snapshot before clicking. Use the page's real PDF, full-text, repository, or download control; do not guess hidden endpoints.
4. If authentication or verification appears, follow the human-handoff rule.
5. After access is established, inspect the page and recent network requests to identify the legitimate document URL and response type.
6. Prefer a direct download when the discovered URL is openly retrievable without exporting session credentials. Otherwise use the visible browser's normal download control.
7. Close the browser session when the attempt is complete or blocked.

Do not declare success merely because a URL ends in `.pdf`; publisher endpoints often return HTML login pages, consent pages, or error documents with a PDF-looking URL.

## Save consistently

For a literature-review workspace, save the article as:

```text
review/papers/<bibkey>.pdf
```

Use the exact BibTeX key that will appear in `review/manuscript/references.bib`. If no key exists yet, derive a stable provisional key, create or update the BibTeX record, and keep the PDF stem identical to that key. Do not overwrite an existing file unless its identity has been checked and the user asked to replace it.

Keep supplementary files distinct, for example:

```text
review/papers/<bibkey>-supplement.pdf
```

Do not attach a supplement in place of the article PDF.

## Verify before reporting success

Check all of the following:

- the saved file exists and is non-empty;
- its content is a PDF rather than an HTML or text response;
- it opens or can be parsed as a PDF;
- title, author, DOI, or other internal metadata matches the requested paper;
- it is the requested article version or is clearly labelled otherwise;
- the final filename follows the BibTeX-key convention;
- an existing file was not unintentionally replaced.

If identity cannot be verified, keep the file out of the canonical `papers/` path or mark the attempt failed. Never let an uncertain download become evidence for a proposition.
