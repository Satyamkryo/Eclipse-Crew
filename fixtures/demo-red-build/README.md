# Demo red build

A tiny Node project with one failing test, used to try the **Dev Agent** template.

## Try it

1. Create a new empty repository on GitHub (for example `your-name/demo-red-build`).
2. Push this folder to it (from inside this folder):

   ```sh
   git init
   git add .
   git commit -m "Add the demo project"
   git branch -M main
   git remote add origin https://github.com/<owner>/<repo>.git
   git push -u origin main
   ```

3. Wait until the **test** workflow is red.
4. In Eclipse Crew: Settings → Connections → add a fine-grained GitHub token for the Dev Agent.
   Give it **Contents: read and write** and **Pull requests: read and write** for that one repository,
   plus **Actions: read**. Do not grant Administration, Workflows or Actions write.
5. Add and pin the GitHub MCP server (`github`), create an agent from the **Dev Agent** template, and ask:
   "Fix the failing build in owner/repo and open a pull request."

There are no secrets in this fixture and no real repository names.
