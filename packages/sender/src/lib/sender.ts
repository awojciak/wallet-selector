import { isMobile } from "@near-wallet-selector/utils";
import {
  WalletModule,
  WalletBehaviourFactory,
  InjectedWallet,
  Action,
  Transaction,
  FunctionCallAction,
  Optional,
  waitFor,
  errors,
} from "@near-wallet-selector/core";

import { InjectedSender } from "./injected-sender";

declare global {
  interface Window {
    near: InjectedSender | undefined;
  }
}

export interface SenderParams {
  iconUrl?: string;
}

interface SenderState {
  wallet: InjectedSender | null;
}

const Sender: WalletBehaviourFactory<InjectedWallet> = ({
  options,
  metadata,
  emitter,
  logger,
}) => {
  const _state: SenderState = { wallet: null };

  const isInstalled = async () => {
    try {
      return await waitFor(() => !!window.near?.isSender);
    } catch (e) {
      logger.log("Sender:isInstalled:error", e);

      return false;
    }
  };

  const cleanup = () => {
    _state.wallet = null;
  };

  // TODO: Remove event listeners.
  // Must only trigger "disconnected" if we were connected.
  const disconnect = async () => {
    if (!_state.wallet) {
      return;
    }

    if (!_state.wallet.isSignedIn()) {
      return cleanup();
    }

    const res = await _state.wallet.signOut();

    if (!res) {
      throw new Error("Failed to disconnect");
    }

    if (typeof res === "object") {
      throw new Error(
        (typeof res.error === "string" ? res.error : res.error.type) ||
          "Failed to disconnect"
      );
    }

    cleanup();

    emitter.emit("disconnected", null);
  };

  const getAccounts = () => {
    if (!_state.wallet) {
      return [];
    }

    const accountId = _state.wallet.getAccountId();

    if (!accountId) {
      return [];
    }

    return [{ accountId }];
  };

  const setupWallet = async (): Promise<InjectedSender> => {
    if (_state.wallet) {
      return _state.wallet;
    }

    const installed = await isInstalled();

    if (!installed) {
      throw errors.createWalletNotInstalledError(metadata);
    }

    _state.wallet = window.near!;

    try {
      // Add extra wait to ensure Sender's sign in status is read from the
      // browser extension background env.
      await waitFor(() => !!_state.wallet?.isSignedIn(), { timeout: 300 });
    } catch (e) {
      logger.log("Sender:setupWallet: Not signed in yet");
    }

    _state.wallet.on("accountChanged", async (newAccountId) => {
      logger.log("Sender:onAccountChange", newAccountId);

      cleanup();

      emitter.emit("disconnected", null);
    });

    _state.wallet.on("rpcChanged", async ({ rpc }) => {
      if (options.network.networkId !== rpc.networkId) {
        await disconnect();

        emitter.emit("networkChanged", { networkId: rpc.networkId });
      }
    });

    return _state.wallet;
  };

  const getWallet = (): InjectedSender => {
    if (!_state.wallet) {
      throw new Error(`${metadata.name} not connected`);
    }

    return _state.wallet;
  };

  const isValidActions = (
    actions: Array<Action>
  ): actions is Array<FunctionCallAction> => {
    return actions.every((x) => x.type === "FunctionCall");
  };

  const transformActions = (actions: Array<Action>) => {
    const validActions = isValidActions(actions);

    if (!validActions) {
      throw new Error(
        `Only 'FunctionCall' actions types are supported by ${metadata.name}`
      );
    }

    return actions.map((x) => x.params);
  };

  const transformTransactions = (
    transactions: Array<Optional<Transaction, "signerId">>
  ) => {
    return transactions.map((transaction) => {
      return {
        receiverId: transaction.receiverId,
        actions: transformActions(transaction.actions),
      };
    });
  };

  return {
    getDownloadUrl() {
      return "https://chrome.google.com/webstore/detail/sender-wallet/epapihdplajcdnnkdeiahlgigofloibg";
    },

    async isAvailable() {
      return !isMobile();
    },

    async connect() {
      const wallet = await setupWallet();
      const existingAccounts = getAccounts();

      if (existingAccounts.length) {
        emitter.emit("connected", { accounts: existingAccounts });
        return existingAccounts;
      }

      const { accessKey, error } = await wallet.requestSignIn({
        contractId: options.contractId,
        methodNames: options.methodNames,
      });

      if (!accessKey || error) {
        await disconnect();

        throw new Error(
          (typeof error === "string" ? error : error.type) ||
            "Failed to connect"
        );
      }

      const newAccounts = getAccounts();
      emitter.emit("connected", { accounts: newAccounts });

      return newAccounts;
    },

    disconnect,

    async getAccounts() {
      return getAccounts();
    },

    async signAndSendTransaction({
      signerId,
      receiverId = options.contractId,
      actions,
    }) {
      logger.log("Sender:signAndSendTransaction", {
        signerId,
        receiverId,
        actions,
      });

      const wallet = getWallet();

      return wallet
        .signAndSendTransaction({
          receiverId,
          actions: transformActions(actions),
        })
        .then((res) => {
          if (res.error) {
            throw new Error(res.error);
          }

          // Shouldn't happen but avoids inconsistent responses.
          if (!res.response?.length) {
            throw new Error("Invalid response");
          }

          return res.response[0];
        });
    },

    async signAndSendTransactions({ transactions }) {
      logger.log("Sender:signAndSendTransactions", { transactions });

      const wallet = getWallet();

      return wallet
        .requestSignTransactions({
          transactions: transformTransactions(transactions),
        })
        .then((res) => {
          if (res.error) {
            throw new Error(res.error);
          }

          // Shouldn't happen but avoids inconsistent responses.
          if (!res.response?.length) {
            throw new Error("Invalid response");
          }

          return res.response;
        });
    },
  };
};

export function setupSender({
  iconUrl = "./assets/sender-icon.png",
}: SenderParams = {}): WalletModule<InjectedWallet> {
  return {
    id: "sender",
    type: "injected",
    name: "Sender",
    description: null,
    iconUrl,
    wallet: Sender,
  };
}
