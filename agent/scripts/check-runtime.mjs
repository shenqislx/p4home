const [major, minor] = process.versions.node.split(".").map(Number);

if (major !== 24 || minor === undefined || minor < 19) {
  process.stderr.write(
    `P4 Home Agent requires Node 24.19 or newer within the Node 24 line; received ${process.version}\n`,
  );
  process.exit(1);
}

process.stdout.write(`Runtime preflight: Node ${process.versions.node}\n`);
