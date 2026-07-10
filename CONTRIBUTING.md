# Contributing to Tool Vision Inventory

Thanks for your interest in improving Tool Vision Inventory. This guide covers how to set up the project locally and the conventions we follow for changes.

## Local setup

1. Fork and clone the repository:
   ```sh
   git clone https://github.com/zalvi22/tool-vision-inventory.git
   cd tool-vision-inventory
   ```
2. Install dependencies:
   ```sh
   npm install
   ```
3. Copy the example environment file and fill in your values:
   ```sh
   cp .env.example .env
   ```
   Set `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, and `VITE_VISION_API_URL`.
4. Apply the SQL migrations in `supabase/migrations/` against your Supabase project.
5. Start the dev server:
   ```sh
   npm run dev
   ```

## Branch and pull request conventions

- Create a feature branch off of the default branch. Use a short, descriptive name, for example `feature/slot-label-export` or `fix/qr-deep-link`.
- Keep pull requests focused on a single change where possible.
- Write a clear PR description that explains what changed and why. Reference any related issues.

## Before you open a PR

Run both of the following and make sure they pass:

```sh
npm run lint
npm run build
```

## Code style

- Match the existing code style in the repository (TypeScript, React 18, shadcn/ui, Tailwind CSS).
- Follow the ESLint configuration already in the project; do not disable rules without good reason.
- Keep components small and consistent with the patterns used elsewhere in `src/`.

## Database changes

All database schema changes must go through new files added to `supabase/migrations/`. Do not edit existing migration files. Name new migrations consistently with the existing timestamped convention so they apply in order.

## Reporting issues

Use the issue templates for bug reports and feature requests. Provide as much detail as you can so we can reproduce and understand the request.
