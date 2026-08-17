export interface GitHubRepositoryLocation {
  owner: string;
  repository: string;
  url: string;
}

const repositoryPart = /^[A-Za-z0-9._-]+$/;

export function parseGitHubRepositoryUrl(input: string): GitHubRepositoryLocation {
  const value = input.trim();
  if (!value) throw new Error("Enter a GitHub repository URL.");

  let url: URL;
  try {
    url = new URL(value.includes("://") ? value : `https://${value}`);
  } catch {
    throw new Error("Enter a valid GitHub repository URL.");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("GitHub repository URLs must use HTTP or HTTPS.");
  }
  if (url.hostname.toLowerCase() !== "github.com" && url.hostname.toLowerCase() !== "www.github.com") {
    throw new Error("Only github.com repository URLs are supported.");
  }

  const [owner = "", rawRepository = ""] = url.pathname.split("/").filter(Boolean);
  const repository = rawRepository.replace(/\.git$/i, "");
  if (!repositoryPart.test(owner) || !repositoryPart.test(repository)) {
    throw new Error("Use a GitHub URL in the form github.com/owner/repository.");
  }

  return {
    owner,
    repository,
    url: `https://github.com/${owner}/${repository}`,
  };
}
