'use client';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex items-center justify-center h-full p-8 text-center">
      <div>
        <h2 className="text-xl font-bold text-white mb-2">Something went wrong</h2>
        <p className="text-slate-400 mb-4">{error.message}</p>
        <button
          onClick={reset}
          className="px-4 py-2 bg-amber-500 text-black rounded-lg text-sm font-semibold"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
