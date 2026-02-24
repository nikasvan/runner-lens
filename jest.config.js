/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testPathIgnorePatterns: ['/node_modules/', 'preview-gen'],
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/post.ts'],
  coverageThreshold: {
    global: { branches: 65, functions: 80, lines: 75, statements: 75 },
  },
  moduleNameMapper: {
    '^@actions/artifact$': '<rootDir>/node_modules/@actions/artifact/lib/artifact.js',
  },
};
