class GitDiagram < Formula
  desc "Show a git diff as a connected file diagram in your browser"
  homepage "https://github.com/hiimak/git-diagram"
  license "MIT"
  head "https://github.com/hiimak/git-diagram.git", branch: "main"

  depends_on "node"

  def install
    libexec.install "git-diagram.mjs", "page.html"
    (bin/"git-diagram").write <<~SH
      #!/bin/sh
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/git-diagram.mjs" "$@"
    SH
  end

  test do
    system "git", "init", "-q"
    assert_match "No changes", shell_output("#{bin}/git-diagram")
  end
end
