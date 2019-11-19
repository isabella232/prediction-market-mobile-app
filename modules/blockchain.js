import localStorage from './localStorage';

import 'ethers/dist/shims.js';
import { ethers } from 'ethers';

import ORCHESTRATOR_JSON from '../contracts/SignallingOrchestrator.json';
import MM_JSON from '../contracts/MarketMaker.json';
import COLLATERAL_JSON from '../contracts/CollateralToken.json';
import CONDITIONAL_TOKENS_JSON from '../contracts/ConditionalTokens.json';

// FIXME: set your local ganache address
const LOCAL_GANACHE_HTTP = 'http://192.168.0.31:8545';
// FIXME: set your deployed signalling orchestrator address
const SIGNALLING_ORCHESTRATOR = '0x9699b0b659FBbFf0FC15cE01F98E76dee5880550';

const ONE = ethers.utils.parseEther("1");
const MIN_ONE = ethers.utils.parseEther("-1");
const HUNDRED = ethers.utils.parseEther("100");

let contracts = null;

function getProvider() {
  // return new ethers.providers.JsonRpcProvider('http://2dac0d50.ngrok.io');
  return new ethers.providers.JsonRpcProvider(LOCAL_GANACHE_HTTP);

  // Connect Infura provider later
}

function generatePrivateKey() {
  let randomWallet = ethers.Wallet.createRandom();
  console.log(randomWallet.privateKey);
  return randomWallet.privateKey;
}

async function getWallet() {
  let privateKey = await localStorage.getPrivateKey();
  if (!privateKey) {
    privateKey = generatePrivateKey();
    await localStorage.savePrivateKey(privateKey);
  }
  
  const provider = getProvider();
  return new ethers.Wallet(privateKey, provider);
}

async function initContracts() {
  contracts = {};
  let wallet = await getWallet();
  contracts.orchestrator = new ethers.Contract(SIGNALLING_ORCHESTRATOR, ORCHESTRATOR_JSON.abi, wallet);
  
  let collateralAddress = await contracts.orchestrator.collateralToken();
  contracts.collateral = new ethers.Contract(collateralAddress, COLLATERAL_JSON.abi, wallet);

  let conditionalTokensAddress = await contracts.orchestrator.conditionalTokens();
  contracts.conditionalTokens = new ethers.Contract(conditionalTokensAddress, CONDITIONAL_TOKENS_JSON.abi, wallet);
}

async function getContracts() {
  if (!contracts) {
    await initContracts();
  }
  return contracts;
}

async function getBalance() {
  let wallet = await getWallet();
  let address = await wallet.getAddress();
  let contracts = await getContracts();
  let balance = await contracts.collateral.balanceOf(address);
  return ethers.utils.formatEther(balance);
}

async function getMarkets() {
  let wallet = await getWallet();
  let address = await wallet.getAddress();
  let contracts = await getContracts();
  let marketsCount = await contracts.orchestrator.getMarketsCount();
  let markets = [];
  for (let marketNr = 0; marketNr < marketsCount.toNumber(); marketNr++) {
    let [address, project, outcome] = await contracts.orchestrator.getMarketDetails(marketNr);
    let market = {
      address,
      project,
      outcome,
    };
    markets.push(market);
  }
  return markets;
}

async function listenOnPriceChanges(mmAddress, onPriceChangedCallback) {
    function convertPriceToNumber(price) {
    return Number.parseFloat(ethers.utils.formatEther(price)).toPrecision(3);
  }

  let wallet = await getWallet();
  wallet.provider.resetEventsBlock(0); // <- it allows to get all events
  let mm = new ethers.Contract(mmAddress, MM_JSON.abi, wallet.provider);
  let filter = mm.filters.AMMPriceChanged();
  
  mm.on(filter, (priceBuyYes, priceSellYes, priceBuyNo, priceSellNo, timestamp) => {
    onPriceChangedCallback({
      priceBuyYes: +convertPriceToNumber(priceBuyYes),
      priceSellYes: -convertPriceToNumber(priceSellYes),
      priceBuyNo: +convertPriceToNumber(priceBuyNo),
      priceSellNo: -convertPriceToNumber(priceSellNo),
      timestamp: timestamp.toNumber(),
    });
  });
}

async function getCurrentPrices(mmAddress) {
  let contracts = await getContracts();
  let wallet = await getWallet();
  let mm = new ethers.Contract(mmAddress, MM_JSON.abi, wallet);
  return {
    Yes: {
      Buy: Number.parseFloat(ethers.utils.formatEther(await mm.calcNetCost([ONE, 0]))).toPrecision(3),
      Sell: (-Number.parseFloat(ethers.utils.formatEther(await mm.calcNetCost([MIN_ONE, 0])))).toPrecision(3),
    },
    No: {
      Buy: Number.parseFloat(ethers.utils.formatEther(await mm.calcNetCost([0, ONE]))).toPrecision(3),
      Sell: (-Number.parseFloat(ethers.utils.formatEther(await mm.calcNetCost([0, MIN_ONE])))).toPrecision(3),
    }
  };
}

async function getBalances(mmAddress) {
  let contracts = await getContracts();
  let wallet = await getWallet();
  let mm = new ethers.Contract(mmAddress, MM_JSON.abi, wallet);
  let yesPosition = await mm.generateAtomicPositionId(0);
  let noPosition = await mm.generateAtomicPositionId(1);
  let result = {};
  result.Yes = ethers.utils.formatEther(await contracts.orchestrator.getOutcomeBalance(wallet.address, yesPosition));
  result.No = ethers.utils.formatEther(await contracts.orchestrator.getOutcomeBalance(wallet.address, noPosition));
  return result;
}

async function trade(mmAddress, type, action) {
  try {
    let wallet = await getWallet();
    let { collateral, conditionalTokens } = await getContracts();
    let mm = new ethers.Contract(mmAddress, MM_JSON.abi, wallet);

    let allowance = await collateral.allowance(wallet.address, mmAddress);

    if (allowance == 0) {
      console.log(`First trading on ${mmAddress}. Joining market...`);
      let setApprovalForAllTx = await conditionalTokens.setApprovalForAll(mmAddress, true, {gasLimit: 1000000});
      console.log({setApprovalForAllTx: setApprovalForAllTx.hash});
      await setApprovalForAllTx.wait();
      let approveTx = await collateral.approve(mmAddress, HUNDRED, {gasLimit: 1000000});
      console.log({approveTx: approveTx.hash});
      await approveTx.wait();
    }
    
    let tokenAmounts = [0, 0];
    let amount = (action == 'buy') ? ONE : MIN_ONE;
    if (type == 'Yes') {
      tokenAmounts[0] = amount;
    }
    if (type == 'No') {
      tokenAmounts[1] = amount;
    }

    let tradeTx = await mm.trade(tokenAmounts, 0, { gasLimit: 1000000 });
    console.log({tradeTx: tradeTx.hash});
    await tradeTx.wait();

    return true;
  } catch (err) {
    // Uncomment for development
    // console.error('Transaction sending error occured');
    // console.error(err);

    return false;
  }
}

export default {
  getWallet,
  getBalance,
  getMarkets,
  listenOnPriceChanges,
  getCurrentPrices,
  getBalances,
  trade,
};
