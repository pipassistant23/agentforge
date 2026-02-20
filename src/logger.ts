import pino from 'pino';

const transport =
  process.stdout.isTTY || process.env.NODE_ENV === 'development'
    ? pino.transport({ target: 'pino-pretty', options: { colorize: true } })
    : undefined;

export const logger = pino({ level: process.env.LOG_LEVEL || 'info' }, transport);

// Route uncaught errors through pino so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
