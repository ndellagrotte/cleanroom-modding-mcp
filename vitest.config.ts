import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.config.ts',
        '**/*.config.js',
        '**/types/**',
        '**/*.d.ts',
      ],
    },
    // `scripts/` is included because the pre-publish corpus lint lives there:
    // it is the gate that decides whether an 818 MiB database may be released,
    // so it needs the same test coverage as the runtime it protects.
    include: ['src/**/*.{test,spec}.ts', 'scripts/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'dist'],
    testTimeout: 60000,
  },
});
