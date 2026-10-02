export const MOCK_DIFFS = {
  singleLineChange: `--- a/src/index.ts
+++ b/src/index.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+const b = 3;
 const c = 4;`,

  multiFileChange: `diff --git a/src/a.ts b/src/a.ts
index 1234567..89abcdef 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@
 function test() {
-  return false;
+  const ready = true;
+  return ready;
 }
diff --git a/src/b.ts b/src/b.ts
index abcdef1..2345678 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,3 @@
-export const X = 1;
+export const X = 2;
+export const Y = 3;`,

  emptyDiff: '',

  whitespaceOnlyDiff: '   \n\n  \t  \n',

  headerOnlyDiff: `diff --git a/src/file.ts b/src/file.ts
new file mode 100644
index 0000000..e69de29`,

  malformedDiff: `Some random text that is not a diff
+just a plus line
-just a minus line
without any chunk header`,

  largeDiff: Array.from({ length: 50 }, (_, i) => `@@ -${i * 10},5 +${i * 10},6 @@\n context line ${i}\n-deleted line ${i}\n+added line ${i}\n+second added line ${i}\n context line end`).join('\n')
};
