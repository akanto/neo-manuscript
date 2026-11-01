// @hutch cli=0.28.2 cottontail=0.7.3
export default {
  scripts: {
    dev: ["hutch", "electrobun", "dev"],
    "dev:watch": ["hutch", "electrobun", "dev", "--watch"],
    build: ["hutch", "electrobun", "build", "--env=stable"],
  },
  electrobun: {
    version: "2.0.5",
  },
};
