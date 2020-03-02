import {
    PoolContract, PoolInstance, 
    FundsModuleContract, FundsModuleInstance, 
    AccessModuleContract, AccessModuleInstance,
    LiquidityModuleContract, LiquidityModuleInstance,
    LoanModuleContract, LoanModuleInstance,
    CurveModuleContract, CurveModuleInstance,
    PTokenContract, PTokenInstance, 
    FreeDAIContract, FreeDAIInstance
} from "../types/truffle-contracts/index";
import Snapshot from "./utils/snapshot";
// tslint:disable-next-line:no-var-requires
const { BN, constants, expectEvent, shouldFail, time } = require("@openzeppelin/test-helpers");
// tslint:disable-next-line:no-var-requires
const expectRevert= require("./utils/expectRevert");
const should = require("chai").should();
var expect = require("chai").expect;
const w3random = require("./utils/w3random");
const findEventArgs = require("./utils/findEventArgs");
const expectEqualBN = require("./utils/expectEqualBN");

const Pool = artifacts.require("Pool");
const FundsModule = artifacts.require("FundsModule");
const AccessModule = artifacts.require("AccessModule");
const LiquidityModule = artifacts.require("LiquidityModule");
const LoanModule = artifacts.require("LoanModule");
const CurveModule = artifacts.require("CurveModule");

const PToken = artifacts.require("PToken");
const FreeDAI = artifacts.require("FreeDAI");

contract("LoanModule", async ([_, owner, liquidityProvider, borrower, ...otherAccounts]) => {
    let snap: Snapshot;

    let pool: PoolInstance;
    let funds: FundsModuleInstance; 
    let access: AccessModuleInstance;
    let liqm: LiquidityModuleInstance; 
    let loanm: LoanModuleInstance; 
    let curve: CurveModuleInstance; 
    let pToken: PTokenInstance;
    let lToken: FreeDAIInstance;

    before(async () => {
        //Setup system contracts
        pool = await Pool.new();
        await (<any> pool).methods['initialize()']({from: owner});

        lToken = await FreeDAI.new();
        await (<any> lToken).methods['initialize()']({from: owner});
        await pool.set("ltoken", lToken.address, true, {from: owner});  

        pToken = await PToken.new();
        await (<any> pToken).methods['initialize(address)'](pool.address, {from: owner});
        await pool.set("ptoken", pToken.address, true, {from: owner});  

        curve = await CurveModule.new();
        await (<any> curve).methods['initialize(address)'](pool.address, {from: owner});
        await pool.set("curve", curve.address, true, {from: owner});  

        access = await AccessModule.new();
        await (<any> access).methods['initialize(address)'](pool.address, {from: owner});
        await pool.set("access", access.address, true, {from: owner});  
        access.disableWhitelist({from: owner});

        liqm = await LiquidityModule.new();
        await (<any> liqm).methods['initialize(address)'](pool.address, {from: owner});
        await pool.set("liquidity", liqm.address, true, {from: owner});  

        loanm = await LoanModule.new();
        await (<any> loanm).methods['initialize(address)'](pool.address, {from: owner});
        await pool.set("loan", loanm.address, true, {from: owner});  

        funds = await FundsModule.new();
        await (<any> funds).methods['initialize(address)'](pool.address, {from: owner});
        await pool.set("funds", funds.address, true, {from: owner});  
        await pToken.addMinter(funds.address, {from: owner});
        await funds.addFundsOperator(liqm.address, {from: owner});
        await funds.addFundsOperator(loanm.address, {from: owner});

        //Do common tasks
        lToken.mint(liquidityProvider, web3.utils.toWei('1000000'), {from: owner});
        await lToken.approve(funds.address, web3.utils.toWei('1000000'), {from: liquidityProvider})

        //Save snapshot
        snap = await Snapshot.create(web3.currentProvider);
    })
    beforeEach(async () => {
        await snap.revert();
    });

    it('should create several debt proposals and take user pTokens', async () => {
        await prepareLiquidity(w3random.interval(1000, 100000, 'ether'));

        for(let i=0; i < 3; i++){
            //Prepare Borrower account
            let lDebtWei = w3random.interval(100, 200, 'ether');
            let lcWei = lDebtWei.div(new BN(2)).add(new BN(1));
            let pAmountMinWei = (await funds.calculatePoolExit(lDebtWei)).div(new BN(2));
            await prepareBorrower(pAmountMinWei);

            //Create Debt Proposal
            let receipt = await loanm.createDebtProposal(lDebtWei, '100', pAmountMinWei, web3.utils.sha3('test'), {from: borrower});
            expectEvent(receipt, 'DebtProposalCreated', {'sender':borrower, 'proposal':String(i), 'lAmount':lDebtWei});

            let proposal = await loanm.debtProposals(borrower, i);
            //console.log(proposal);
            expect((<any>proposal).lAmount).to.be.bignumber.equal(lDebtWei);    //amount
            expect((<any>proposal).executed).to.be.false;                       //executed 
        }            
    });

    it('should create pledge in debt proposal', async () => {
        await prepareLiquidity(w3random.interval(1000, 100000, 'ether'));

        //Prepare Borrower account
        let lDebtWei = w3random.interval(100, 200, 'ether');
        let lcWei = lDebtWei.div(new BN(2)).add(new BN(1));
        let pAmountMinWei = (await funds.calculatePoolExit(lDebtWei)).div(new BN(2));
        // console.log('lcWei', lcWei.toString());
        // console.log('pAmountMinWei', pAmountMinWei.toString());
        await prepareBorrower(pAmountMinWei);

        //Create Debt Proposal
        let receipt = await loanm.createDebtProposal(lDebtWei, '100', pAmountMinWei, web3.utils.sha3('test'), {from: borrower});
        let proposalIdx = findEventArgs(receipt, 'DebtProposalCreated')['proposal'].toString();
        //console.log(proposalIdx);

        //Add Pleddge
        let pledgeRequirements = await loanm.getPledgeRequirements(borrower, proposalIdx);
        // console.log('pledgeRequirements', pledgeRequirements[0].toString(), pledgeRequirements[1].toString());
        let lPledgeWei = w3random.intervalBN(pledgeRequirements[0], pledgeRequirements[1]);
        let pPledgeWei = await funds.calculatePoolExit(lPledgeWei);
        let elPledgeWei = await funds.calculatePoolExitInverse(pPledgeWei);
        expectEqualBN(elPledgeWei[0],lPledgeWei);
        await prepareSupporter(pPledgeWei, otherAccounts[0]);
        receipt = await loanm.addPledge(borrower, proposalIdx, pPledgeWei, '0',{from: otherAccounts[0]});
        // console.log('lAmount', elPledgeWei[0], elPledgeWei[0].toString());
        // console.log('pAmount', pPledgeWei, pPledgeWei.toString());
        expectEvent(receipt, 'PledgeAdded', {'sender':otherAccounts[0], 'borrower':borrower, 'proposal':String(proposalIdx), 'lAmount':elPledgeWei[0], 'pAmount':pPledgeWei});
    });
    it('should withdraw pledge in debt proposal', async () => {
        await prepareLiquidity(w3random.interval(1000, 100000, 'ether'));

        //Prepare Borrower account
        let lDebtWei = w3random.interval(100, 200, 'ether');
        let lcWei = lDebtWei.div(new BN(2)).add(new BN(1));
        let pAmountMinWei = (await funds.calculatePoolExit(lDebtWei)).div(new BN(2));
        await prepareBorrower(pAmountMinWei);

        //Create Debt Proposal
        let receipt = await loanm.createDebtProposal(lDebtWei, '100', pAmountMinWei, web3.utils.sha3('test'), {from: borrower});
        let proposalIdx = findEventArgs(receipt, 'DebtProposalCreated')['proposal'].toString();
        //console.log(proposalIdx);

        //Add Pleddge
        let pledgeRequirements = await loanm.getPledgeRequirements(borrower, proposalIdx);
        //console.log('pledgeRequirements', pledgeRequirements[0].toString(), pledgeRequirements[1].toString());
        let lPledgeWei = w3random.intervalBN(pledgeRequirements[0], pledgeRequirements[1]);
        // let lPledgeWei = w3random.intervalBN(lDebtWei.div(new BN(10)), lDebtWei.div(new BN(2)), 'ether');
        // console.log('lPledgeWei', lPledgeWei.toString(), lDebtWei.div(new BN(2)).toString());
        let pPledgeWei = await funds.calculatePoolExit(lPledgeWei);
        let elPledgeWei = await funds.calculatePoolExitInverse(pPledgeWei);
        expectEqualBN(elPledgeWei[0],lPledgeWei);
        await prepareSupporter(pPledgeWei, otherAccounts[0]);
        receipt = await loanm.addPledge(borrower, proposalIdx, pPledgeWei, '0', {from: otherAccounts[0]});

        //Withdraw pledge
        //TODO - find out problem with full pledge withraw
        receipt = await loanm.withdrawPledge(borrower, proposalIdx, pPledgeWei, {from: otherAccounts[0]});  
        expectEvent(receipt, 'PledgeWithdrawn', {'sender':otherAccounts[0], 'borrower':borrower, 'proposal':String(proposalIdx), 'lAmount':elPledgeWei[0], 'pAmount':pPledgeWei});
    });
    it('should not allow borrower withdraw too much of his pledge', async () => {
        await prepareLiquidity(w3random.interval(1000, 100000, 'ether'));

        //Prepare Borrower account
        let lDebtWei = w3random.interval(100, 200, 'ether');
        let lcWei = lDebtWei.div(new BN(2)).add(new BN(1));
        let pAmountMinWei = (await funds.calculatePoolExit(lDebtWei)).div(new BN(2));
        await prepareBorrower(pAmountMinWei);

        //Create Debt Proposal
        let receipt = await loanm.createDebtProposal(lDebtWei, '100', pAmountMinWei, web3.utils.sha3('test'), {from: borrower});
        let proposalIdx = findEventArgs(receipt, 'DebtProposalCreated')['proposal'].toString();
        //console.log(proposalIdx);

        //Add Pleddge
        let pledgeRequirements = await loanm.getPledgeRequirements(borrower, proposalIdx);
        //console.log('pledgeRequirements', pledgeRequirements[0].toString(), pledgeRequirements[1].toString());
        let lPledgeWei = w3random.intervalBN(pledgeRequirements[0], pledgeRequirements[1]);
        let pPledgeWei = await funds.calculatePoolExit(lPledgeWei);
        // console.log('lPledgeWei', lPledgeWei.toString());
        // console.log('pPledgeWei', pPledgeWei.toString());
        await prepareSupporter(pPledgeWei, otherAccounts[0]);
        receipt = await loanm.addPledge(borrower, proposalIdx, pPledgeWei, '0', {from: otherAccounts[0]});

        //Withdraw pledge
        await expectRevert(
            loanm.withdrawPledge(borrower, proposalIdx, pPledgeWei.add(new BN(1)), {from: otherAccounts[0]}),
            'LoanModule: Can not withdraw more than locked'
        );  
    });
    it('should execute successful debt proposal', async () => {
        await prepareLiquidity(w3random.interval(1000, 100000, 'ether'));

        //Prepare Borrower account
        let lDebtWei = w3random.interval(100, 200, 'ether');
        let lcWei = lDebtWei.div(new BN(2)).add(new BN(1));
        let pAmountMinWei = (await funds.calculatePoolExit(lDebtWei)).div(new BN(2));
        await prepareBorrower(pAmountMinWei);

        //Create Debt Proposal
        let receipt = await loanm.createDebtProposal(lDebtWei, '100', pAmountMinWei, web3.utils.sha3('test'), {from: borrower});
        let proposalIdx = findEventArgs(receipt, 'DebtProposalCreated')['proposal'].toString();

        //Add supporter
        let lPledge = await loanm.getRequiredPledge(borrower, proposalIdx);
        let pPledge = await funds.calculatePoolExit(lPledge);
        await prepareSupporter(pPledge, otherAccounts[0]);
        await loanm.addPledge(borrower, proposalIdx, pPledge, '0',{from: otherAccounts[0]});

        receipt = await loanm.executeDebtProposal(proposalIdx, {from: borrower});
        expectEvent(receipt, 'DebtProposalExecuted', {'sender':borrower, 'proposal':String(proposalIdx), 'lAmount':lDebtWei});
    });
    it('should not execute successful debt proposal if debt load is too high', async () => {
        let liquidity = w3random.interval(200, 400, 'ether')
        await prepareLiquidity(liquidity);

        //Prepare Borrower account
        let lDebtWei = liquidity.div(new BN(2)).add(new BN(1));
        //console.log('lDebtWei', lDebtWei.toString());
        let lcWei = lDebtWei.div(new BN(2)).add(new BN(1));
        let pAmountMinWei = (await funds.calculatePoolExit(lDebtWei)).div(new BN(2));
        await prepareBorrower(pAmountMinWei);

        //Create Debt Proposal
        let receipt = await loanm.createDebtProposal(lDebtWei, '100', pAmountMinWei, web3.utils.sha3('test'), {from: borrower});
        let proposalIdx = findEventArgs(receipt, 'DebtProposalCreated')['proposal'].toString();

        //Add supporter
        let lPledge = await loanm.getRequiredPledge(borrower, proposalIdx);
        let pPledge = await funds.calculatePoolExit(lPledge);
        await prepareSupporter(pPledge, otherAccounts[0]);
        await loanm.addPledge(borrower, proposalIdx, pPledge, '0',{from: otherAccounts[0]});
        // console.log('lBalance', (await funds.lBalance()).toString());
        // console.log('lDebts', (await loanm.totalLDebts()).toString());

        await expectRevert(
            loanm.executeDebtProposal(proposalIdx, {from: borrower}),
            "LoanModule: DebtProposal can not be executed now because of debt loan limit"
        );
    });
    it('should repay debt and interest', async () => {
        await prepareLiquidity(w3random.interval(1000, 100000, 'ether'));

        let debtLAmount = w3random.interval(100, 200, 'ether');
        let debtIdx = await createDebt(debtLAmount, otherAccounts[0]);
        let borrowerLBalance = await lToken.balanceOf(borrower);
        expect(borrowerLBalance).to.be.bignumber.gte(debtLAmount);

        // Partial repayment
        await time.increase(w3random.interval(30*24*60*60, 89*24*60*60));
        let repayLAmount = debtLAmount.div(new BN(3));
        await lToken.approve(funds.address, repayLAmount, {from: borrower});
        let receipt = await loanm.repay(debtIdx, repayLAmount, {from: borrower});
        expectEvent(receipt, 'Repay', {'sender':borrower, 'debt':debtIdx});
        let debtLRequiredPayments = await loanm.getDebtRequiredPayments(borrower, debtIdx);
        expect(debtLRequiredPayments[0]).to.be.bignumber.gt(new BN(0));
        expect(debtLRequiredPayments[1]).to.be.bignumber.eq(new BN(0));        

        // Repay rest
        await time.increase(w3random.interval(30*24*60*60, 89*24*60*60));
        debtLRequiredPayments = await loanm.getDebtRequiredPayments(borrower, debtIdx);
        //console.log('debtLRequiredPayments', debtLRequiredPayments[0].toString(), debtLRequiredPayments[1].toString());
        expect(debtLRequiredPayments[1]).to.be.bignumber.gt(new BN(0));

        let fullRepayLAmount = debtLRequiredPayments[0].add(debtLRequiredPayments[1]).add(debtLRequiredPayments[0].div(new BN(1000))); //add 0.1% of full left amount to handle possible additiona interest required
        await lToken.transfer(borrower, fullRepayLAmount, {from: liquidityProvider});
        await lToken.approve(funds.address, fullRepayLAmount, {from: borrower});
        receipt = await loanm.repay(debtIdx, fullRepayLAmount, {from: borrower});
        expectEvent(receipt, 'Repay', {'sender':borrower, 'debt':debtIdx});

        debtLRequiredPayments = await loanm.getDebtRequiredPayments(borrower, debtIdx);
        expect(debtLRequiredPayments[0]).to.be.bignumber.eq(new BN(0));
        expect(debtLRequiredPayments[1]).to.be.bignumber.eq(new BN(0));
    });
    it('should partially redeem pledge from debt', async () => {
        await prepareLiquidity(w3random.interval(1000, 100000, 'ether'));

        let debtLAmount = w3random.interval(100, 200, 'ether');
        //console.log('Debt lAmount', web3.utils.fromWei(debtLAmount));
        let debtIdx = await createDebt(debtLAmount, otherAccounts[0]);
        let borrowerLBalance = await lToken.balanceOf(borrower);
        expect(borrowerLBalance).to.be.bignumber.gte(debtLAmount);

        //Check pledge Info
        let pledgeInfo = await loanm.calculatePledgeInfo(borrower, debtIdx, otherAccounts[0]);
        //console.log('Before repay', pledgeInfo);
        let pPledge = pledgeInfo[0];
        //console.log('Pledge pAmount', web3.utils.fromWei(pPledge));
        expect(pledgeInfo[1]).to.be.bignumber.eq('0');
        expect(pledgeInfo[2]).to.be.bignumber.eq('0');
        expect(pledgeInfo[3]).to.be.bignumber.eq('0');

        // Partial repayment
        let randTime = w3random.interval(30*24*60*60, 89*24*60*60);
        //console.log('Days passed', randTime/(24*60*60));
        await time.increase(randTime);
        let repayLAmount = w3random.intervalBN(debtLAmount.div(new BN(10)), debtLAmount.div(new BN(2)));
        //console.log('Repay lAmount', web3.utils.fromWei(repayLAmount));
        await lToken.approve(funds.address, repayLAmount, {from: borrower});
        await loanm.repay(debtIdx, repayLAmount, {from: borrower});

        //Redeem unlocked pledge
        pledgeInfo = await loanm.calculatePledgeInfo(borrower, debtIdx, otherAccounts[0]);
        // console.log('After repay', pledgeInfo);
        // console.log('Pledge locked', web3.utils.fromWei(pledgeInfo[0]));
        // console.log('Pledge unlocked', web3.utils.fromWei(pledgeInfo[1]));
        // console.log('Pledge interest', web3.utils.fromWei(pledgeInfo[2]));
        expectEqualBN(pledgeInfo[0].add(pledgeInfo[1]), pPledge); // Locked + unlocked = full pledge
        expect(pledgeInfo[1]).to.be.bignumber.gt('0');    // Something is unlocked
        expect(pledgeInfo[2]).to.be.bignumber.gt('0');    // Some interest receieved
        expect(pledgeInfo[3]).to.be.bignumber.eq('0');    // Nothing withdrawn yet

        let receipt = await loanm.withdrawUnlockedPledge(borrower, debtIdx, {from: otherAccounts[0]});
        let expectedPWithdraw = pledgeInfo[1].add(pledgeInfo[2]).sub(pledgeInfo[3]);
        expectEvent(receipt, 'UnlockedPledgeWithdraw', {'sender':otherAccounts[0], 'borrower':borrower, 'debt':String(debtIdx), });
    });
    it('should fully redeem pledge from fully paid debt (without partial redeem)', async () => {
        await prepareLiquidity(w3random.interval(1000, 100000, 'ether'));

        let debtLAmount = w3random.interval(100, 200, 'ether');
        let debtIdx = await createDebt(debtLAmount, otherAccounts[0]);
        let borrowerLBalance = await lToken.balanceOf(borrower);
        expect(borrowerLBalance).to.be.bignumber.gte(debtLAmount);
        await lToken.transfer(borrower, debtLAmount.div(new BN(20)), {from: liquidityProvider});    //Transfer 5% of debtLAmount for paying interest

        // Full repayment
        await time.increase(w3random.interval(30*24*60*60, 89*24*60*60));
        let requiredPayments = await loanm.getDebtRequiredPayments(borrower, debtIdx);
        expect(requiredPayments[0]).to.be.bignumber.eq(debtLAmount); // Debt equal to loaned amount   
        expect(requiredPayments[1]).to.be.bignumber.gt('0');         // Some interest payment required
        let repayLAmount = requiredPayments[0].add(requiredPayments[1]).add(requiredPayments[0].div(new BN(1000)));
        await lToken.approve(funds.address, repayLAmount, {from: borrower});
        await loanm.repay(debtIdx, repayLAmount, {from: borrower});

        //Withdraw pledge
        let pledgeInfo = await loanm.calculatePledgeInfo(borrower, debtIdx, otherAccounts[0]);
        let expectedPWithdraw = pledgeInfo[1].add(pledgeInfo[2]).sub(pledgeInfo[3]);
        let receipt = await loanm.withdrawUnlockedPledge(borrower, debtIdx, {from: otherAccounts[0]});
        expectEvent(receipt, 'UnlockedPledgeWithdraw', {'sender':otherAccounts[0], 'borrower':borrower, 'debt':String(debtIdx), 'pAmount':expectedPWithdraw});
    });
    it('should fully redeem pledge from fully paid debt (after partial redeem)', async () => {
        await prepareLiquidity(w3random.interval(1000, 100000, 'ether'));

        let debtLAmount = w3random.interval(100, 200, 'ether');
        let debtIdx = await createDebt(debtLAmount, otherAccounts[0]);
        let borrowerLBalance = await lToken.balanceOf(borrower);
        expect(borrowerLBalance).to.be.bignumber.gte(debtLAmount);
        await lToken.transfer(borrower, debtLAmount.div(new BN(10)), {from: liquidityProvider});    //Transfer 10% of debtLAmount for paying interest

        // Partial repayment
        await time.increase(w3random.interval(30*24*60*60, 89*24*60*60));
        let repayLAmount = w3random.intervalBN(debtLAmount.div(new BN(10)), debtLAmount.div(new BN(2)));
        await lToken.approve(funds.address, repayLAmount, {from: borrower});
        await loanm.repay(debtIdx, repayLAmount, {from: borrower});


        //Withdraw pledge
        let pledgeInfo = await loanm.calculatePledgeInfo(borrower, debtIdx, otherAccounts[0]);
        let expectedPWithdraw = pledgeInfo[1].add(pledgeInfo[2]).sub(pledgeInfo[3]);
        let receipt = await loanm.withdrawUnlockedPledge(borrower, debtIdx, {from: otherAccounts[0]});
        expectEvent(receipt, 'UnlockedPledgeWithdraw', {'sender':otherAccounts[0], 'borrower':borrower, 'debt':String(debtIdx), 'pAmount':expectedPWithdraw});

        // Full repayment
        await time.increase(w3random.interval(30*24*60*60, 89*24*60*60));
        let requiredPayments = await loanm.getDebtRequiredPayments(borrower, debtIdx);
        repayLAmount = requiredPayments[0].add(requiredPayments[1]).add(requiredPayments[0].div(new BN(1000)));
        await lToken.approve(funds.address, repayLAmount, {from: borrower});
        await loanm.repay(debtIdx, repayLAmount, {from: borrower});

        //Withdraw pledge
        pledgeInfo = await loanm.calculatePledgeInfo(borrower, debtIdx, otherAccounts[0]);
        expectedPWithdraw = pledgeInfo[1].add(pledgeInfo[2]).sub(pledgeInfo[3]);
        receipt = await loanm.withdrawUnlockedPledge(borrower, debtIdx, {from: otherAccounts[0]});
        expectEvent(receipt, 'UnlockedPledgeWithdraw', {'sender':otherAccounts[0], 'borrower':borrower, 'debt':String(debtIdx), 'pAmount':expectedPWithdraw});
    });
    it('should not allow repay after default date', async () => {
        await prepareLiquidity(w3random.interval(1000, 100000, 'ether'));

        let debtLAmount = w3random.interval(100, 200, 'ether');
        let debtIdx = await createDebt(debtLAmount, otherAccounts[0]);
        let borrowerLBalance = await lToken.balanceOf(borrower);
        expect(borrowerLBalance).to.be.bignumber.gte(debtLAmount);
        await lToken.transfer(borrower, debtLAmount.div(new BN(10)), {from: liquidityProvider});    //Transfer 10% of debtLAmount for paying interest

        await time.increase(90*24*60*60+1);

        let hasActiveDebts = await loanm.hasActiveDebts(borrower);
        expect(hasActiveDebts).to.be.false;

        await expectRevert(
            loanm.repay(debtIdx, debtLAmount, {from:borrower}),
            'LoanModule: debt is already defaulted'
        );
    });

    it('should allow supporter to take part of the pledge after default date', async () => {
        // for(let r = 0; r < 20; r++){
        //     await snap.revert();
            await prepareLiquidity(w3random.interval(1000, 100000, 'ether'));

            let debtLAmount = w3random.interval(100, 200, 'ether');
            let debtIdx = await createDebt(debtLAmount, otherAccounts[0]);
            let borrowerLBalance = await lToken.balanceOf(borrower);
            expect(borrowerLBalance).to.be.bignumber.gte(debtLAmount);
            await lToken.transfer(borrower, debtLAmount.div(new BN(10)), {from: liquidityProvider});    //Transfer 10% of debtLAmount for paying interest

            // Partial repayment
            await time.increase(w3random.interval(30*24*60*60, 89*24*60*60));
            let repayLAmount = w3random.intervalBN(debtLAmount.div(new BN(10)), debtLAmount.div(new BN(2)));
            await lToken.approve(funds.address, repayLAmount, {from: borrower});
            await loanm.repay(debtIdx, repayLAmount, {from: borrower});
            let pledgeInfoBeforeDefault = await loanm.calculatePledgeInfo(borrower, debtIdx, otherAccounts[0]);
            console.log('before default', pledgeInfoBeforeDefault);

            await time.increase(90*24*60*60+1);
            let pPoolBalanceBefore = await pToken.balanceOf(funds.address);
            await loanm.executeDebtDefault(borrower, debtIdx);
            let pPoolBalanceAfter = await pToken.balanceOf(funds.address);
            expect(pPoolBalanceAfter).to.be.bignumber.lt(pPoolBalanceBefore);

            let hasActiveDebts = await loanm.hasActiveDebts(borrower);
            expect(hasActiveDebts).to.be.false;

            let pledgeInfoAfterDefault = await loanm.calculatePledgeInfo(borrower, debtIdx, otherAccounts[0]);
            console.log('after default', pledgeInfoAfterDefault);
            expect(pledgeInfoAfterDefault[0]).to.be.bignumber.eq(new BN(0));
            expect(pledgeInfoAfterDefault[1]).to.be.bignumber.gt(pledgeInfoBeforeDefault[1]); //TODO: calculate how many PTK added from borrower's pledge
            expect(pledgeInfoAfterDefault[2]).to.be.bignumber.eq(pledgeInfoBeforeDefault[2]);
            expect(pledgeInfoAfterDefault[3]).to.be.bignumber.eq(pledgeInfoBeforeDefault[3]);

            let receipt = await loanm.withdrawUnlockedPledge(borrower, debtIdx, {from: otherAccounts[0]});
            expectEvent(receipt, 'UnlockedPledgeWithdraw', {'pAmount':pledgeInfoAfterDefault[1].add(pledgeInfoAfterDefault[2].sub(pledgeInfoAfterDefault[3]))});
        // }
    });
    // it('should correctly calculate totalLDebts()', async () => {
    // });

    async function prepareLiquidity(amountWei:BN){
        await liqm.deposit(amountWei, '0', {from: liquidityProvider});
    }
    async function prepareBorrower(pAmount:BN){
        await pToken.mint(borrower, pAmount, {from: owner});
        //await pToken.approve(funds.address, pAmount, {from: borrower});
        //console.log('Borrower pBalance', (await pToken.balanceOf(borrower)).toString());
    }
    async function prepareSupporter(pAmount:BN, supporter:string){
        await pToken.mint(supporter, pAmount, {from: owner});
        //await pToken.approve(funds.address, pAmount, {from: supporter});
    }

    async function createDebt(debtLAmount:BN, supporter:string){
        //Prepare Borrower account
        let pAmountMinWei = (await funds.calculatePoolExit(debtLAmount)).div(new BN(2));
        await prepareBorrower(pAmountMinWei);

        //Create Debt Proposal
        let receipt = await loanm.createDebtProposal(debtLAmount, '100', pAmountMinWei, web3.utils.sha3('test'), {from: borrower}); //50 means 5 percent
        let proposalIdx = findEventArgs(receipt, 'DebtProposalCreated')['proposal'].toString();

        //Add supporter
        let lPledge = await loanm.getRequiredPledge(borrower, proposalIdx);
        let pPledge = await funds.calculatePoolExit(lPledge);
        await prepareSupporter(pPledge, supporter);
        await loanm.addPledge(borrower, proposalIdx, pPledge, '0',{from: supporter});

        receipt = await loanm.executeDebtProposal(proposalIdx, {from: borrower});
        let debtIdx = findEventArgs(receipt, 'DebtProposalExecuted')['debt'];
        return debtIdx;
    }
});
