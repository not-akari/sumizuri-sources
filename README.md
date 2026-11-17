# Sumizuri official sources

Connectors that let [Sumizuri](https://github.com/not-akari/sumizuri) read and play from servers you run yourself. They bring no content. They show what is already on your own server.

Sumizuri adds this repo for you. To add it by hand, open Browse, then Repos, and add:

```
https://raw.githubusercontent.com/not-akari/sumizuri-sources/main
```

## Connectors

| Connector | What it shows | How it signs in |
| --- | --- | --- |
| Komga | Comics, manga and books (EPUB and PDF) | An API key from Komga, under Account settings, API keys |
| Kavita | Comics, manga and books (EPUB and PDF) | Your API key from Kavita, under Settings, Account |
| Jellyfin | Shows and movies, with seasons, subtitles and intro skip when the server has it | Your Jellyfin user name and password |

After you install one, open its settings and fill in your server address and sign in details.

## Servers at home

Addresses like `192.168.1.20` or `nas.local` are on your home network. Sumizuri blocks those for every source unless you allow it. Turn on **Home network** in the connector's settings to reach them.

## Your keys and passwords

- Passwords and keys are kept in your device's secure storage.
- They are only sent to the server address you typed in that connector's settings.
- Each connector only talks to your server.

## Adding a connector

Each connector is a folder named after its id, holding its `index.js`. The folder goes inside the one for what it shows: `comics`, `novels`, `mixed` (comics and books) or `anime` (video).

List it in `versioning.json`, with a `sha256` of its `index.js`. When you change a connector, raise its `version` and update the `sha256`:

```bash
sha256sum mixed/komga/index.js
```

On Windows PowerShell, use `(Get-FileHash mixed\komga\index.js).Hash.ToLower()`.

## License

MIT, see [LICENSE](LICENSE).
