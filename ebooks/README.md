# Companion ebooks

**Nothing in here that is a PDF may be committed. This repository is public.**
`.gitignore` blocks `ebooks/*.pdf`; do not override it. A paid product in a
public repo is a free product.

Where the files actually belong:

- A **private** Supabase Storage bucket (not public-read), or any object store
  that can issue short-lived signed URLs.
- Delivery goes through an entitlement check: the app asks the backend for a
  signed URL, the backend confirms the buyer owns that ebook, and returns a URL
  that expires in minutes. Never link the object directly.

This directory exists as the staging spot when preparing an upload, and as the
place to look when someone asks where the books live.
