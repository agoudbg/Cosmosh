let shouldOpenLocalTerminalList = false;

export const requestOpenLocalTerminalList = (): void => {
  shouldOpenLocalTerminalList = true;
};

export const consumeOpenLocalTerminalListRequest = (): boolean => {
  const shouldConsume = shouldOpenLocalTerminalList;
  shouldOpenLocalTerminalList = false;
  return shouldConsume;
};
