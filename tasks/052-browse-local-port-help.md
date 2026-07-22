# Task 052: Browse local port help GUI

Status: complete

Add an in-app help experience that explains and launches Tessera's local-port
Browser proxy without requiring users to consult external documentation.

## Requirements

- Add a connected-nodes network icon control to every Browser pane toolbar.
  Render it as a theme-colored inline SVG rather than a `?`, with the accessible
  label and tooltip **Browse local port help**.
- Open a focused modal titled **Browse a Local Port** from that control.
- Add a **Browse Local Port Help** command-palette entry that opens the same
  dialog directly. When invoked without a current Browser pane, the dialog's
  **Open in Browser** action creates a Browser pane and navigates it.
- Present a short, visual quick-start flow:
  1. start an HTTP development server on the Tessera host;
  2. enter `localhost:<port>` or an explicit loopback HTTP/HTTPS URL;
  3. open it through Tessera's existing listener.
- Include an address field initialized from the current Browser pane, falling
  back to `localhost:5000`, and an **Open in Browser** action that validates the
  address, closes the help modal, and navigates that pane or a newly created
  Browser pane.
- Show useful examples for Flask and common development-server commands without
  implying that Tessera starts those servers itself.
- Explain the network boundary: Tessera opens no additional port; a service
  bound to loopback remains reachable remotely only through Tessera, while a
  service bound to `0.0.0.0` may already be exposed independently.
- Summarize proxy limitations including cookie authentication, service workers,
  strict origin assumptions, and cross-origin redirects.
- Reuse Tessera's existing modal styling, backdrop dismissal, Escape handling,
  focus behavior, and responsive layout.
- Keep the help entirely client-side and do not add port scanning or new server
  endpoints.

## Verification

- Add focused frontend tests for the help dialog's default/current address
  selection and example addresses.
- Verify the command-palette entry is present and targets the same help flow.
- Verify valid and invalid address submission behavior through the existing
  Browser address normalization path.
- Run all frontend tests, `node --check web/app.js`, `go test ./...`, and
  `git diff --check`.

## Completion

- Added a theme-colored connected-nodes SVG control to every Browser toolbar,
  with an accessible **Browse local port help** label and tooltip.
- Added the shared **Browse a Local Port** dialog with a validated launch field,
  visual quick-start steps, selectable Flask/Vite/Python examples, network
  exposure guidance, and compatibility notes.
- Added the **Browse Local Port Help** (`BL`) command-palette route. Its launch
  action reuses the active Browser pane or creates a new one when opened
  globally.
- Kept the feature entirely client-side and reused the existing loopback address
  validation and Browser proxy creation path.
- Added frontend coverage for current/default address selection, examples, and
  command metadata. Visually verified toolbar and command entry points,
  validation, Browser creation, current-address preservation, desktop layout,
  and the 480-pixel responsive layout with no console errors.
- Verified all frontend tests, `node --check web/app.js`, `go test ./...`, and
  `git diff --check`.
