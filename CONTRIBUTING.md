# Contributing

Thanks for helping maintain the community Readium Alchemy index.

- Reproduce parser issues against a saved, public `index.html` fixture.
- Never execute the upstream HTML or evaluate its JavaScript. Parse literal data.
- Keep the default polling interval at five minutes or slower; do not create
  aggressive polling loops.
- Include a short test or fixture for parser changes.
- Do not submit secrets, Firebase credentials, user IDs, or private save data.
- Keep the service read-only with respect to the upstream Readium repository.
