# Contributing to Google Codmod Web Wrapper

We welcome contributions, bug reports, and feature suggestions from our customers and community!

## How to Contribute

1. **Fork the repository** on GitHub.
2. **Create a feature branch** (`git checkout -b feature/amazing-feature`).
3. **Commit your changes** with descriptive commit messages.
4. **Push your branch** (`git push origin feature/amazing-feature`).
5. **Open a Pull Request** against the `main` branch.

## Development Environment Setup

1. Make sure you have **Node.js 20+** installed.
2. Clone your fork and run:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
4. Start the development server:
   ```bash
   npm run dev
   ```
   - By default, when running locally without Google Cloud credentials, the wrapper will use the local mock binary in `./bin/codmod` and save generated reports to `./mock-storage/`.

## Code Style & Guidelines

- Keep code clean, readable, and well-documented.
- Ensure any new backend CLI options are properly validated in [server.js](file:///Users/misbahh/work/projects/coba-sdlc/codmod-web-wrapper/server.js).
- Ensure frontend UI changes align with the Google Cloud Console aesthetic in [public/style.css](file:///Users/misbahh/work/projects/coba-sdlc/codmod-web-wrapper/public/style.css).
