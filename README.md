# Openference for SillyTavern

Adds **Openference** to SillyTavern's Chat Completion sources, with a **Connect with Openference** button that signs you in and saves an API key for you. No copying and pasting.

[Openference](https://openference.com) is AI model access and API infrastructure for developers. This extension is for people who want to chat and roleplay with those models in SillyTavern.

## Requirements

- SillyTavern 1.20.0 or newer. Until that release is out, use the `staging` branch.
- An Openference account. Signing in also offers a plan or credits if your account has neither yet.

On an older SillyTavern, use the **Custom (OpenAI-compatible)** source instead: the [setup guide](https://docs.openference.com/integrations/sillytavern) covers it.

## Install

1. In SillyTavern, open **Extensions > Install extension**.
2. Paste `https://github.com/Openference/SillyTavern-Openference` and confirm.

## Connect

1. Open **API Connections** and set **API** to **Chat Completion**.
2. Under **Chat Completion Source**, pick **Openference** in the **Custom Providers** group.
3. Click **Connect with Openference**, then **Open Openference**. Sign in, add credits if asked, and approve.
4. Come back to SillyTavern. The key is saved and selected for you. Click **Connect** and choose a model.

You do not need to connect with the button. You can also pick **Openference**, create a key on the [API Keys](https://openference.com/user/tokens) page of your dashboard, paste it into the key field and click **Connect**.

Using SillyTavern on another machine, a phone or in Docker? The button works the same: open the link on any device, or go to the address shown under it and type the code.

## What the button does

- It asks Openference for a sign-in code, shows it next to the link, and then checks whether you approved it.
- When you approve, Openference creates a **new API key** named "SillyTavern (OAuth *date*)" on your account. It uses your plan and credits like any other key.
- SillyTavern saves the key in its own key list as "Openference *date*", the same list you get from the key button next to the key field. The extension keeps it nowhere else, shows it nowhere, and does not touch the key you already use with the plain Custom source.
- If SillyTavern cannot save the key, the extension shows it once so you can copy it into the key field yourself.
- To take access back, delete the key on the [API Keys](https://openference.com/user/tokens) page. A deleted key no longer works anywhere, SillyTavern included.

Every account has a limit on how many API keys it can have. If you reach it, the sign-in tells you: delete one you no longer use and try again.

## Settings

The extension has no settings of its own. Everything you can change is SillyTavern's own provider card: key, model, and the advanced connection details.

## Good to know

- Keep **Unlocked Context Size** off and cap **Context (tokens)** at 128K to 200K. Prompts far larger than that are a common reason for **Blocked** or empty replies. The [setup guide](https://docs.openference.com/integrations/sillytavern) explains where to set it.
- **Connect** lists the models your key can use, so the list can differ between accounts.
- If you remove the extension, the connection you saved keeps working. Only the **Connect with Openference** button goes away.

## Support

- Documentation: <https://docs.openference.com/integrations/sillytavern>
- Help with Openference or this extension: <https://openference.com/contact>
- Problems with SillyTavern itself belong in the [SillyTavern issue tracker](https://github.com/SillyTavern/SillyTavern/issues).

## Development

Clone this repository into SillyTavern's `public/scripts/extensions/third-party/` folder. The plain JavaScript files need no build step.

| File | What it does |
| --- | --- |
| `index.js` | Registers the provider and draws the **Connect with Openference** control in the provider card. |
| `device-flow.js` | The sign-in itself (OAuth device flow, [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)): asks for a code, waits for the approval, returns the key. Runs in Node. |
| `key-store.js` | Saves the key in SillyTavern's key list and points the connection at it. Runs in Node. |
| `test/` | Tests for the two files above. Run them with `npm test` (Node 20 or newer). |

## License

AGPL-3.0, like SillyTavern. This extension is based on the [SillyTavern provider extension example](https://github.com/SillyTavern/Extension-ProviderExample), which is AGPL-3.0.
