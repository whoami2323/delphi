pragma solidity ^0.5.12;

import "@openzeppelin/contracts-ethereum-package/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts-ethereum-package/contracts/token/ERC20/SafeERC20.sol";
import "@openzeppelin/contracts-ethereum-package/contracts/math/SafeMath.sol";

import "../../interfaces/defi/IVaultProtocol.sol";
import "../../common/Module.sol";
import "./DefiOperatorRole.sol";

contract VaultProtocol is Module, IVaultProtocol, DefiOperatorRole {
    using SafeMath for uint256;
    using SafeERC20 for IERC20;

    struct DepositData {
        address depositedToken;
        uint256 depositedAmount;
    }

    //filled up in the overloaded adapter method
    address[] internal registeredVaultTokens;

    //deposits waiting for the defi operator's actions
    mapping(address => DepositData[]) internal balancesOnHold;
    address[] internal usersDeposited; //for operator's conveniency

    //Withdraw requests waiting for the defi operator's actions
    mapping(address => DepositData[]) internal balancesRequested;
    address[] internal usersRequested; //for operator's conveniency

    mapping(address => DepositData[]) internal balancesToClaim;
    uint256[] internal claimableTokens;

    function initialize(address _pool) public initializer {
        Module.initialize(_pool);
        DefiOperatorRole.initialize(_msgSender());
    }


//IVaultProtocol methods
    function depositToVault(address _user, address _token, uint256 _amount) public onlyDefiOperator {
        require(_user != address(0), "Incorrect user address");
        require(_token != address(0), "Incorrect token address");
        require(_amount > 0, "No tokens to be deposited");

        IERC20(_token).transferFrom(_user, address(this), _amount);

        uint256 ind;
        bool hasToken;

        hasToken = isTokenRegistered(_token);
        require(hasToken, "Token is not registered in the vault");

        (hasToken, ind) = hasOnHoldToken(_user, _token);

        if (hasToken) {
            balancesOnHold[_user][ind].depositedAmount = balancesOnHold[_user][ind].depositedAmount.add(_amount);
        }
        else {
            if (balancesOnHold[_user].length == 0) {
                usersDeposited.push(_user);
            }
            balancesOnHold[_user].push( DepositData({
                depositedToken: _token,
                depositedAmount: _amount
            }) );
        }

        emit DepositToVault(_user, _token, _amount);
    }

    function depositToVault(address _user, address[] memory  _tokens, uint256[] memory _amounts) public onlyDefiOperator {
        require(_tokens.length > 0, "No tokens to be deposited");
        require(_tokens.length == _amounts.length, "Incorrect amounts");

        for (uint256 i = 0; i < _tokens.length; i++) {
            depositToVault(_user, _tokens[i], _amounts[i]);
        }
    }

    function withdrawFromVault(address _user, address _token, uint256 _amount) public onlyDefiOperator {
        require(_user != address(0), "Incorrect user address");
        require(_token != address(0), "Incorrect token address");
        require(_amount > 0, "No tokens to be withdrawn");

        if (IERC20(_token).balanceOf(address(this)) >= _amount) {
            IERC20(_token).transfer(_user, _amount);

            emit WithdrawFromVault(_user, _token, _amount);

            updateOnHoldDeposit(_user, _token, _amount);
        }
        else {
            uint256 ind;
            bool hasRequest;

            hasRequest = isTokenRegistered(_token);
            require(hasRequest, "Token is not registered in the vault");
            
            (hasRequest, ind) = hasRequestedToken(_user, _token);

            if (hasRequest) {
                balancesRequested[_user][ind].depositedAmount = balancesRequested[_user][ind].depositedAmount.add(_amount);
            }
            else {
                if (balancesRequested[_user].length == 0) {
                    usersRequested.push(_user);
                }
                balancesRequested[_user].push( DepositData({
                    depositedToken: _token,
                    depositedAmount: _amount
                }) );
            }

            emit WithdrawRequestCreated(_user, _token, _amount);
        }
    }

    function withdrawFromVault(address _user, address[] memory  _tokens, uint256[] memory _amounts) public onlyDefiOperator {
        require(_tokens.length > 0, "No tokens to be withdrawn");
        require(_tokens.length == _amounts.length, "Incorrect amounts");

        for (uint256 i = 0; i < _tokens.length; i++) {
            withdrawFromVault(_user, _tokens[i], _amounts[i]);
        }
    }

    function withdrawOperator() public onlyDefiOperator {
        //Yield distribution step based on actual deposits (excluding on-hold ones)
        // should be performed from the SavingsModule before other operator's actions

        clearOnHoldDeposits();
        
        uint256 totalWithdraw = 0;
        uint256[] memory withdrawAmounts = new uint256[](registeredVaultTokens.length);
        for (uint256 i = 0; i < usersRequested.length; i++) {
            for (uint256 j = 0; j < balancesRequested[usersRequested[i]].length; j++) {
                uint256 am = balancesRequested[usersRequested[i]][j].depositedAmount;
                if (am > 0) {
                    uint256 ind = tokenRegisteredInd(balancesRequested[usersRequested[i]][j].depositedToken);
                    withdrawAmounts[ind].add(am);
                    totalWithdraw = totalWithdraw.add(am);

                    addClaim(usersRequested[i], balancesRequested[usersRequested[i]][j].depositedToken, am);
                    //claim if need
    //                if (IERC20(_deposits[i].depositedToken).balanceOf(address(this).sub(claimedTokens[ind])) >= _deposits[i].depositedAmount) {
    //
    //               }
                }
            }
            //move tokens to claim if there is a liquidity
                //handleClaim(balancesRequested[usersRequested[i]]);
                //tokenRegisteredInd()
            //calculate withdraw amounts
            delete balancesRequested[usersRequested[i]];
        }
        delete usersRequested;

        uint256[] memory amounts = new uint256[](registeredVaultTokens.length);
        uint256 totalDeposit = 0;
        for (uint256 i = 0; i < registeredVaultTokens.length; i++) {
            amounts[i] = IERC20(registeredVaultTokens[i]).balanceOf(address(this)).sub(claimableTokens[i]);
            totalDeposit = totalDeposit.add(amounts[i]);
        }
        //one of two things should happen for the same token: deposit or withdraw
        //simultaneous deposit and withdraw are applied to different tokens
        if (totalDeposit > 0) {
            handleDeposit(registeredVaultTokens, amounts);
            emit DepositRequestResolved(totalDeposit);
        }

        if (totalWithdraw > 0) {
            withdraw(address(this), withdrawAmounts);
            emit WithdrawRequestResolved(totalWithdraw);
        }
    }
/*    handleClaim() {
        for (uint256 i = 0; i < _deposits.length; i++) {
            if (_deposits[i].depositedAmount > 0) {
                uint256 ind = tokenRegisteredInd(_deposits[i].depositedToken);
                if (IERC20(_deposits[i].depositedToken).balanceOf(address(this).sub(claimedTokens[ind])) >= _deposits[i].depositedAmount) {

                }
            }
        }
    }*/

    function quickWithdraw(address _user, uint256 _amount) public {
        //stab
        //available for any how pays for all the gas and is allowed to withdraw
        //should be overloaded in the protocol adapter itself
    }

    function claimRequested(address _user) public {
        for (uint256 i = 0; i < balancesToClaim[_user].length; i++) {
            IERC20(balancesToClaim[_user][i].depositedToken).transfer(_user, balancesToClaim[_user][i].depositedAmount);
        }
        delete balancesToClaim[_user];
    }

    function claimableAmount(address _user, address _token) public view returns (uint256) {
        uint256 amount = 0;
        for (uint i = 0; i < balancesToClaim[_user].length; i++) {
            if (balancesToClaim[_user][i].depositedToken == _token) {
                amount = balancesToClaim[_user][i].depositedAmount;
                break;
            }
        }
        return amount;
    }

    function addClaim(address _user, address _token, uint256 _amount) internal {
        uint256 ind;
        bool hasClaim;
        (hasClaim, ind) = hasClaimToken(_user, _token);

        if (hasClaim) {
            balancesToClaim[_user][ind].depositedAmount = balancesToClaim[_user][ind].depositedAmount.add(_amount);
        }
        else {
            balancesToClaim[_user].push( DepositData({
                depositedToken: _token,
                depositedAmount: _amount
            }) );
        }
    }

    function hasClaimToken(address _user, address _token) internal view returns (bool, uint256) {
        uint256 ind = 0;
        bool hasToken = false;
        for (uint i = 0; i < balancesToClaim[_user].length; i++) {
            if (balancesToClaim[_user][i].depositedToken == _token) {
                ind = i;
                hasToken = true;
                break;
            }
        }
        return (hasToken, ind);
    }

    function hasOnHoldToken(address _user, address _token) internal view returns (bool, uint256) {
        uint256 ind = 0;
        bool hasToken = false;
        for (uint i = 0; i < balancesOnHold[_user].length; i++) {
            if (balancesOnHold[_user][i].depositedToken == _token) {
                ind = i;
                hasToken = true;
                break;
            }
        }
        return (hasToken, ind);
    }

    function amountOnHold(address _user, address _token) public view returns (uint256) {
        uint256 amount = 0;
        for (uint i = 0; i < balancesOnHold[_user].length; i++) {
            if (balancesOnHold[_user][i].depositedToken == _token) {
                amount = balancesOnHold[_user][i].depositedAmount;
                break;
            }
        }
        return amount;
    }

    function updateOnHoldDeposit(address _user, address _token, uint256 _amount) internal {
        uint256 ind;
        bool hasToken;
        (hasToken, ind) = hasOnHoldToken(_user, _token);

        if (hasToken) {
            uint256 onHoldBalance = balancesOnHold[_user][ind].depositedAmount;
            if (onHoldBalance > _amount) {
                balancesOnHold[_user][ind].depositedAmount = onHoldBalance.sub(_amount);
            }
            else {
                if (balancesOnHold[_user].length == 1) {
                    delete balancesOnHold[_user];
                }
                else {
                    //Will be deleted by operator on resolving on-hold deposites
                    balancesOnHold[_user][ind].depositedAmount = 0;
                }
            }
        }
    }

    function hasRequestedToken(address _user, address _token) internal view returns (bool, uint256) {
        uint256 ind = 0;
        bool hasToken = false;
        for (uint i = 0; i < balancesRequested[_user].length; i++) {
            if (balancesRequested[_user][i].depositedToken == _token) {
                ind = i;
                hasToken = true;
                break;
            }
        }
        return (hasToken, ind);
    }

    function amountRequested(address _user, address _token) public view returns (uint256) {
        uint256 amount = 0;
        for (uint i = 0; i < balancesRequested[_user].length; i++) {
            if (balancesRequested[_user][i].depositedToken == _token) {
                amount = balancesRequested[_user][i].depositedAmount;
                break;
            }
        }
        return amount;
    }

    function isTokenRegistered(address _token) internal view returns (bool) {
        bool isReg = false;
        for (uint i = 0; i < registeredVaultTokens.length; i++) {
            if (registeredVaultTokens[i] == _token) {
                isReg = true;
                break;
            }
        }
        return isReg;
    }

    function tokenRegisteredInd(address _token) internal view returns (uint256) {
        uint256 ind = 0;
        for (uint i = 0; i < registeredVaultTokens.length; i++) {
            if (registeredVaultTokens[i] == _token) {
                ind = i;
                break;
            }
        }
        return ind;
    }

    function clearOnHoldDeposits() internal onlyDefiOperator {
        for (uint256 i = 0; i < usersDeposited.length; i++) {
            //We can delete the on-hold records now - the real balances will be deposited to protocol
            delete balancesOnHold[usersDeposited[i]];
        }
        delete usersDeposited;
    }

//IDefiProtocol methods
    //handleDeposit() and withdraw() methods should be overloaded in the adapter
    function handleDeposit(address token, uint256 amount) public;

    function handleDeposit(address[] memory tokens, uint256[] memory amounts) public; 

    function withdraw(address beneficiary, address token, uint256 amount) public;

    function withdraw(address beneficiary, uint256[] memory amounts) public;




    function claimRewards() public returns(address[] memory tokens, uint256[] memory amounts) {
        tokens = new address[](1);
        amounts = new uint256[](1);
    }

    function withdrawReward(address token, address user, uint256 amount) public {

    }


    function balanceOf(address token) public returns(uint256) {
        return 0;
    }

    function balanceOfAll() external returns(uint256[] memory) {
        uint256[] memory a = new uint256[](1);
        return a;
    }

    function optimalProportions() external returns(uint256[] memory) {
                uint256[] memory a = new uint256[](1);
        return a;
    }

    function normalizedBalance() external returns(uint256) {
        return 0;
    }

    function supportedTokens() public view returns(address[] memory) {
        return registeredVaultTokens;
    }

    function supportedTokensCount() public view returns(uint256) {
        return registeredVaultTokens.length;
    }

    function supportedRewardTokens() external view returns(address[] memory) {
        address[] memory a = new address[](1);
        return a;
    }

    function isSupportedRewardToken(address token) external view returns(bool) {
        return false;
    }

    function canSwapToToken(address token) external view returns(bool) {
        return false;
    }

}